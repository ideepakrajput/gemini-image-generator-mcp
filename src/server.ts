import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_UPLOAD_X_API_KEY = "";

function text(content: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof content === "string" ? content : JSON.stringify(content, null, 2)
      }
    ]
  };
}

function normalizePublicImageUrl(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => normalizePublicImageUrl(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      normalizePublicImageUrl(entry)
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}

function assertMcpApiKey(providedApiKey?: string) {
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

async function generateImageWithGemini(prompt: string, model: string): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY;
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

  const inlineData =
    body?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData ??
    body?.candidates?.flatMap((c: any) => c?.content?.parts ?? []).find((p: any) => p.inlineData)?.inlineData;

  if (!inlineData?.data) {
    throw new Error(`Gemini did not return inline image data: ${JSON.stringify(body)}`);
  }

  return Buffer.from(inlineData.data, "base64");
}

async function uploadImageToEndpoint(input: {
  imagePath: string;
  endpoint?: string;
  bearerToken?: string;
  xApiKey?: string;
  origin?: string;
  referer?: string;
}) {
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

  const resolvedBearerToken =
    input.bearerToken ??
    process.env.UPLOAD_BEARER_TOKEN ??
    process.env.BEARER_TOKEN;
  const resolvedXApiKey =
    input.xApiKey ??
    process.env.UPLOAD_X_API_KEY ??
    process.env.X_API_KEY ??
    DEFAULT_UPLOAD_X_API_KEY;

  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*"
  };
  const resolvedOrigin = input.origin ?? process.env.ORIGIN;
  const resolvedReferer = input.referer ?? process.env.REFERER;
  if (resolvedOrigin) headers.origin = resolvedOrigin;
  if (resolvedReferer) headers.referer = resolvedReferer;
  if (resolvedBearerToken) headers.authorization = `Bearer ${resolvedBearerToken}`;
  if (resolvedXApiKey) headers["x-api-key"] = resolvedXApiKey;

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: form
  });

  const raw = await res.text();
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
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

export function createServer(): McpServer {
  const server = new McpServer({
    name: "gemini-image-generator-mcp",
    version: "0.2.0"
  });

  server.tool(
    "generate_image",
    "Generate an image via Gemini and save to disk.",
    {
      prompt: z.string().min(3),
      output_path: z.string().min(1),
      model: z.string().default(DEFAULT_IMAGE_MODEL),
      mcp_api_key: z.string().optional()
    },
    async (input) => {
      assertMcpApiKey(input.mcp_api_key);
      const image = await generateImageWithGemini(input.prompt, input.model);
      const outDir = path.dirname(input.output_path);
      await fs.promises.mkdir(outDir, { recursive: true });
      await fs.promises.writeFile(input.output_path, image);
      return text({
        ok: true,
        output_path: input.output_path,
        bytes: image.byteLength,
        model: input.model
      });
    }
  );

  server.tool(
    "upload_image",
    "Upload a local image file to upload-public endpoint (x-api-key supported).",
    {
      image_path: z.string().min(1),
      endpoint: z.string().url().optional(),
      bearer_token: z.string().optional(),
      x_api_key: z.string().optional(),
      origin: z.string().optional(),
      referer: z.string().optional(),
      mcp_api_key: z.string().optional()
    },
    async (input) => {
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
    }
  );

  server.tool(
    "generate_and_upload",
    "Generate an image via Gemini, save it, then upload to upload-public endpoint.",
    {
      prompt: z.string().min(3),
      output_path: z.string().min(1),
      endpoint: z.string().url().optional(),
      bearer_token: z.string().optional(),
      x_api_key: z.string().optional(),
      origin: z.string().optional(),
      referer: z.string().optional(),
      model: z.string().default(DEFAULT_IMAGE_MODEL),
      mcp_api_key: z.string().optional()
    },
    async (input) => {
      assertMcpApiKey(input.mcp_api_key);
      const image = await generateImageWithGemini(input.prompt, input.model);
      await fs.promises.mkdir(path.dirname(input.output_path), { recursive: true });
      await fs.promises.writeFile(input.output_path, image);

      const endpoint = input.endpoint ?? process.env.UPLOAD_ENDPOINT;
      if (!endpoint) {
        return text({
          generated: {
            output_path: input.output_path,
            bytes: image.byteLength,
            model: input.model
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
        generated: {
          output_path: input.output_path,
          bytes: image.byteLength,
          model: input.model
        },
        upload: {
          used_auth: upload.usedAuth,
          used_x_api_key: upload.usedXApiKey,
          endpoint,
          ...upload
        }
      });
    }
  );

  return server;
}
