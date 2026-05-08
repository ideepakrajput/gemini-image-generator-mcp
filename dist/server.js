import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { packageJsonVersion } from "./paths.js";
import { z } from "zod";
const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_OPENAI_IMAGE_SIZE = "1024x1024";
const DEFAULT_UPLOAD_X_API_KEY = "";
function text(content) {
    return {
        content: [
            {
                type: "text",
                text: typeof content === "string" ? content : JSON.stringify(content, null, 2)
            }
        ]
    };
}
function normalizePublicImageUrl(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        return value.map((entry) => normalizePublicImageUrl(entry));
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value).map(([key, entry]) => [
            key,
            normalizePublicImageUrl(entry)
        ]);
        return Object.fromEntries(entries);
    }
    return value;
}
function assertMcpApiKey(providedApiKey) {
    const requiredApiKey = process.env.MCP_STATIC_API_KEY;
    if (!requiredApiKey) {
        return;
    }
    if (!providedApiKey) {
        throw new Error("Unauthorized: mcp_api_key is required.");
    }
    if (providedApiKey !== requiredApiKey) {
        throw new Error("Unauthorized: invalid mcp_api_key.");
    }
}
function normalizeProviderEnv(raw) {
    const v = raw?.trim().toLowerCase();
    if (v === "gemini" || v === "google")
        return "gemini";
    if (v === "openai")
        return "openai";
    return "auto";
}
/**
 * Which backend to use for image generation.
 * Backward compatible: with only GEMINI_API_KEY set (legacy configs), uses Gemini.
 * With only OPENAI_API_KEY, uses OpenAI. Both keys + auto → Gemini first.
 */
function resolveImageProvider(toolProvider) {
    const envFlag = normalizeProviderEnv(process.env.IMAGE_GENERATION_PROVIDER);
    if (toolProvider) {
        if (toolProvider === "gemini" && !process.env.GEMINI_API_KEY?.trim()) {
            throw new Error("provider is gemini but GEMINI_API_KEY is not set.");
        }
        if (toolProvider === "openai" && !process.env.OPENAI_API_KEY?.trim()) {
            throw new Error("provider is openai but OPENAI_API_KEY is not set.");
        }
        return toolProvider;
    }
    if (envFlag === "gemini") {
        if (!process.env.GEMINI_API_KEY?.trim()) {
            throw new Error("IMAGE_GENERATION_PROVIDER=gemini but GEMINI_API_KEY is not set.");
        }
        return "gemini";
    }
    if (envFlag === "openai") {
        if (!process.env.OPENAI_API_KEY?.trim()) {
            throw new Error("IMAGE_GENERATION_PROVIDER=openai but OPENAI_API_KEY is not set.");
        }
        return "openai";
    }
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    const openaiKey = process.env.OPENAI_API_KEY?.trim();
    if (geminiKey)
        return "gemini";
    if (openaiKey)
        return "openai";
    throw new Error("No image API key configured. Set GEMINI_API_KEY and/or OPENAI_API_KEY, or set IMAGE_GENERATION_PROVIDER with the matching key.");
}
/** If the tool still passes the default Gemini model while using OpenAI, swap to OpenAI default. */
function resolveModelForProvider(provider, model) {
    if (provider === "openai") {
        const openaiDefault = process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_OPENAI_IMAGE_MODEL;
        if (model === DEFAULT_GEMINI_IMAGE_MODEL ||
            /gemini|imagen|flash-image/i.test(model)) {
            return openaiDefault;
        }
        return model;
    }
    return process.env.GEMINI_IMAGE_MODEL?.trim() || model;
}
async function generateImageWithGemini(prompt, model) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set.");
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const payload = {
        contents: [
            {
                role: "user",
                parts: [{ text: prompt }]
            }
        ],
        generationConfig: {
            responseModalities: ["TEXT", "IMAGE"]
        }
    };
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    const body = await res.json();
    if (!res.ok) {
        throw new Error(`Gemini API error (${res.status}): ${JSON.stringify(body)}`);
    }
    const inlineData = body?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData ??
        body?.candidates
            ?.flatMap((c) => c?.content?.parts ?? [])
            .find((p) => p.inlineData)?.inlineData;
    if (!inlineData?.data) {
        throw new Error(`Gemini did not return inline image data: ${JSON.stringify(body)}`);
    }
    return Buffer.from(inlineData.data, "base64");
}
async function generateImageWithOpenAI(prompt, model, imageSize) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is not set.");
    }
    const base = process.env.OPENAI_BASE_URL?.trim()?.replace(/\/+$/, "") || "https://api.openai.com";
    const url = `${base}/v1/images/generations`;
    const size = imageSize?.trim() ||
        process.env.OPENAI_IMAGE_SIZE?.trim() ||
        DEFAULT_OPENAI_IMAGE_SIZE;
    const requestBody = {
        model,
        prompt,
        n: 1,
        size
    };
    if (!/^gpt-image-/i.test(model) && model !== "chatgpt-image-latest") {
        requestBody.response_format = "b64_json";
    }
    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
    });
    const body = await res.json();
    if (!res.ok) {
        throw new Error(`OpenAI API error (${res.status}): ${JSON.stringify(body)}`);
    }
    const b64 = body?.data?.[0]?.b64_json;
    if (!b64 || typeof b64 !== "string") {
        throw new Error(`OpenAI did not return b64_json: ${JSON.stringify(body)}`);
    }
    return Buffer.from(b64, "base64");
}
async function generateImageBytes(input) {
    const model = resolveModelForProvider(input.provider, input.model);
    if (input.provider === "gemini") {
        return generateImageWithGemini(input.prompt, model);
    }
    return generateImageWithOpenAI(input.prompt, model, input.image_size);
}
const sharedGenerationFields = {
    prompt: z.string().min(3),
    output_path: z.string().min(1),
    /** Defaults to the current Gemini image model; OpenAI path rewrites Gemini-looking models automatically. */
    model: z.string().default(DEFAULT_GEMINI_IMAGE_MODEL),
    /** Per-call override; otherwise IMAGE_GENERATION_PROVIDER or auto from keys. */
    provider: z.enum(["gemini", "openai"]).optional(),
    /** OpenAI images API size (e.g. 1024x1024). Ignored for Gemini. */
    image_size: z.string().optional(),
    mcp_api_key: z.string().optional()
};
async function uploadImageToEndpoint(input) {
    const endpoint = input.endpoint ?? process.env.UPLOAD_ENDPOINT;
    if (!endpoint) {
        throw new Error("UPLOAD_ENDPOINT is not set. Provide endpoint input or set UPLOAD_ENDPOINT.");
    }
    const data = await fs.promises.readFile(input.imagePath);
    const fileName = path.basename(input.imagePath);
    const mimeType = fileName.toLowerCase().endsWith(".webp")
        ? "image/webp"
        : fileName.toLowerCase().endsWith(".jpg") || fileName.toLowerCase().endsWith(".jpeg")
            ? "image/jpeg"
            : "image/png";
    const form = new FormData();
    form.append("image", new Blob([data], { type: mimeType }), fileName);
    const resolvedBearerToken = input.bearerToken ??
        process.env.UPLOAD_BEARER_TOKEN ??
        process.env.BEARER_TOKEN;
    const resolvedXApiKey = input.xApiKey ??
        process.env.UPLOAD_X_API_KEY ??
        process.env.X_API_KEY ??
        DEFAULT_UPLOAD_X_API_KEY;
    const headers = {
        accept: "application/json, text/plain, */*"
    };
    const resolvedOrigin = input.origin ?? process.env.ORIGIN;
    const resolvedReferer = input.referer ?? process.env.REFERER;
    if (resolvedOrigin)
        headers.origin = resolvedOrigin;
    if (resolvedReferer)
        headers.referer = resolvedReferer;
    if (resolvedBearerToken)
        headers.authorization = `Bearer ${resolvedBearerToken}`;
    if (resolvedXApiKey)
        headers["x-api-key"] = resolvedXApiKey;
    const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: form
    });
    const raw = await res.text();
    let parsed = raw;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        // Keep raw response if non-JSON.
    }
    parsed = normalizePublicImageUrl(parsed);
    return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        response: parsed,
        usedAuth: Boolean(resolvedBearerToken),
        usedXApiKey: Boolean(resolvedXApiKey)
    };
}
export function createServer() {
    const server = new McpServer({
        name: "gemini-image-generator-mcp",
        version: packageJsonVersion()
    });
    server.tool("generate_image", "Generate an image via Gemini or OpenAI (see env keys / IMAGE_GENERATION_PROVIDER) and save to disk.", sharedGenerationFields, async (input) => {
        assertMcpApiKey(input.mcp_api_key);
        const provider = resolveImageProvider(input.provider);
        const image = await generateImageBytes({
            prompt: input.prompt,
            provider,
            model: input.model,
            image_size: input.image_size
        });
        const outDir = path.dirname(input.output_path);
        await fs.promises.mkdir(outDir, { recursive: true });
        await fs.promises.writeFile(input.output_path, image);
        return text({
            ok: true,
            provider,
            output_path: input.output_path,
            bytes: image.byteLength,
            model: resolveModelForProvider(provider, input.model),
            ...(provider === "openai" && input.image_size
                ? { image_size: input.image_size }
                : provider === "openai"
                    ? {
                        image_size: process.env.OPENAI_IMAGE_SIZE?.trim() || DEFAULT_OPENAI_IMAGE_SIZE
                    }
                    : {})
        });
    });
    server.tool("upload_image", "Upload a local image file to upload-public endpoint (x-api-key supported).", {
        image_path: z.string().min(1),
        endpoint: z.string().url().optional(),
        bearer_token: z.string().optional(),
        x_api_key: z.string().optional(),
        origin: z.string().optional(),
        referer: z.string().optional(),
        mcp_api_key: z.string().optional()
    }, async (input) => {
        assertMcpApiKey(input.mcp_api_key);
        const result = await uploadImageToEndpoint({
            imagePath: input.image_path,
            endpoint: input.endpoint,
            bearerToken: input.bearer_token,
            xApiKey: input.x_api_key,
            origin: input.origin,
            referer: input.referer
        });
        return text({
            image_path: input.image_path,
            endpoint: input.endpoint ?? process.env.UPLOAD_ENDPOINT,
            used_auth: result.usedAuth,
            used_x_api_key: result.usedXApiKey,
            ...result
        });
    });
    server.tool("generate_and_upload", "Generate an image (Gemini or OpenAI), save it, then upload to upload-public endpoint.", {
        ...sharedGenerationFields,
        endpoint: z.string().url().optional(),
        bearer_token: z.string().optional(),
        x_api_key: z.string().optional(),
        origin: z.string().optional(),
        referer: z.string().optional()
    }, async (input) => {
        assertMcpApiKey(input.mcp_api_key);
        const provider = resolveImageProvider(input.provider);
        const image = await generateImageBytes({
            prompt: input.prompt,
            provider,
            model: input.model,
            image_size: input.image_size
        });
        await fs.promises.mkdir(path.dirname(input.output_path), { recursive: true });
        await fs.promises.writeFile(input.output_path, image);
        const endpoint = input.endpoint ?? process.env.UPLOAD_ENDPOINT;
        if (!endpoint) {
            return text({
                provider,
                generated: {
                    output_path: input.output_path,
                    bytes: image.byteLength,
                    model: resolveModelForProvider(provider, input.model)
                },
                upload: {
                    skipped: true,
                    reason: "No upload endpoint provided. Returning local generated image path."
                }
            });
        }
        const upload = await uploadImageToEndpoint({
            imagePath: input.output_path,
            endpoint,
            bearerToken: input.bearer_token,
            xApiKey: input.x_api_key,
            origin: input.origin,
            referer: input.referer
        });
        return text({
            provider,
            generated: {
                output_path: input.output_path,
                bytes: image.byteLength,
                model: resolveModelForProvider(provider, input.model)
            },
            upload: {
                used_auth: upload.usedAuth,
                used_x_api_key: upload.usedXApiKey,
                endpoint,
                ...upload
            }
        });
    });
    return server;
}
