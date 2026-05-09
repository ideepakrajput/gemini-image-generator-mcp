import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { packageJsonVersion } from "./paths.js";
import { z } from "zod";

const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_OPENAI_IMAGE_SIZE = "1024x1024";
const DEFAULT_UPLOAD_X_API_KEY = "";

type ImageProvider = "gemini" | "openai";

type ReferenceImage = {
  data: Buffer;
  mimeType: string;
  name: string;
};

type ReferenceImageInput = {
  type?: string;
  data?: string;
  base64?: string;
  data_uri?: string;
  mimeType?: string;
  mime_type?: string;
  name?: string;
};

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

function normalizeProviderEnv(raw?: string): ImageProvider | "auto" {
  const v = raw?.trim().toLowerCase();
  if (v === "gemini" || v === "google") return "gemini";
  if (v === "openai") return "openai";
  return "auto";
}

function inferImageMimeType(name: string, fallback = "image/png"): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".png")) return "image/png";
  return fallback;
}

function bufferToBlobPart(data: Buffer): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(data);
}

function collectStringList(...values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      result.push(value.trim());
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) result.push(item.trim());
      }
    }
  }
  return result;
}

function normalizeBase64Data(value: string): string {
  return value.replace(/\s/g, "");
}

function parseDataUri(value: string): { data: string; mimeType?: string } | undefined {
  const match = value.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is);
  if (!match) return undefined;
  return {
    mimeType: match[1],
    data: normalizeBase64Data(match[2])
  };
}

function loadReferenceImageFromBase64(input: {
  data: string;
  mimeType?: string;
  name?: string;
}): ReferenceImage {
  const parsedDataUri = parseDataUri(input.data);
  const data = parsedDataUri?.data ?? normalizeBase64Data(input.data);
  const name = input.name?.trim() || "reference-image.png";
  const mimeType =
    input.mimeType?.trim() ||
    parsedDataUri?.mimeType ||
    inferImageMimeType(name);

  return {
    data: Buffer.from(data, "base64"),
    mimeType,
    name
  };
}

function loadReferenceImageFromObject(input: ReferenceImageInput): ReferenceImage | undefined {
  const data = input.data_uri ?? input.data ?? input.base64;
  if (!data) return undefined;
  return loadReferenceImageFromBase64({
    data,
    mimeType: input.mimeType ?? input.mime_type,
    name: input.name
  });
}

function collectReferenceImageObjects(...values: unknown[]): ReferenceImageInput[] {
  const result: ReferenceImageInput[] = [];
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result.push(value as ReferenceImageInput);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          result.push(item as ReferenceImageInput);
        }
      }
    }
  }
  return result;
}

async function loadReferenceImageFromPath(imagePath: string): Promise<ReferenceImage> {
  const data = await fs.promises.readFile(imagePath);
  return {
    data,
    mimeType: inferImageMimeType(imagePath),
    name: path.basename(imagePath)
  };
}

async function loadReferenceImageFromUrl(imageUrl: string): Promise<ReferenceImage> {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Unable to fetch reference image (${res.status}): ${imageUrl}`);
  }
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
  const data = Buffer.from(await res.arrayBuffer());
  const urlPath = new URL(imageUrl).pathname;
  const name = path.basename(urlPath) || "reference-image.png";
  return {
    data,
    mimeType:
      contentType && contentType.startsWith("image/")
        ? contentType
        : inferImageMimeType(name),
    name
  };
}

async function loadReferenceImages(input: {
  reference_image_path?: string;
  reference_image_paths?: string[];
  reference_image_url?: string;
  reference_image_urls?: string[];
  reference_image_base64?: string;
  reference_image_data_uri?: string;
  reference_image_mime_type?: string;
  reference_image_name?: string;
  reference_image?: ReferenceImageInput;
  reference_images?: ReferenceImageInput[];
}): Promise<ReferenceImage[]> {
  const paths = collectStringList(input.reference_image_path, input.reference_image_paths);
  const urls = collectStringList(input.reference_image_url, input.reference_image_urls);
  const encodedImages = collectStringList(
    input.reference_image_base64,
    input.reference_image_data_uri
  ).map((data) =>
    loadReferenceImageFromBase64({
      data,
      mimeType: input.reference_image_mime_type,
      name: input.reference_image_name
    })
  );
  const objectImages = collectReferenceImageObjects(
    input.reference_image,
    input.reference_images
  )
    .map((image) => loadReferenceImageFromObject(image))
    .filter((image): image is ReferenceImage => Boolean(image));
  const images = await Promise.all([
    ...paths.map((imagePath) => loadReferenceImageFromPath(imagePath)),
    ...urls.map((imageUrl) => loadReferenceImageFromUrl(imageUrl))
  ]);
  return [...images, ...encodedImages, ...objectImages];
}

/**
 * Which backend to use for image generation.
 * Backward compatible: with only GEMINI_API_KEY set (legacy configs), uses Gemini.
 * With only OPENAI_API_KEY, uses OpenAI. Both keys + auto → Gemini first.
 */
function resolveImageProvider(toolProvider?: ImageProvider): ImageProvider {
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
  if (geminiKey) return "gemini";
  if (openaiKey) return "openai";

  throw new Error(
    "No image API key configured. Set GEMINI_API_KEY and/or OPENAI_API_KEY, or set IMAGE_GENERATION_PROVIDER with the matching key."
  );
}

/** If the tool still passes the default Gemini model while using OpenAI, swap to OpenAI default. */
function resolveModelForProvider(provider: ImageProvider, model: string): string {
  if (provider === "openai") {
    const openaiDefault = process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_OPENAI_IMAGE_MODEL;
    if (
      model === DEFAULT_GEMINI_IMAGE_MODEL ||
      /gemini|imagen|flash-image/i.test(model)
    ) {
      return openaiDefault;
    }
    return model;
  }
  return process.env.GEMINI_IMAGE_MODEL?.trim() || model;
}

async function generateImageWithGemini(
  prompt: string,
  model: string,
  referenceImages: ReferenceImage[] = []
): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          ...referenceImages.map((image) => ({
            inlineData: {
              mimeType: image.mimeType,
              data: image.data.toString("base64")
            }
          })),
          { text: prompt }
        ]
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
    body?.candidates?.[0]?.content?.parts?.find((p: { inlineData?: unknown }) => p.inlineData)?.inlineData ??
    body?.candidates
      ?.flatMap((c: { content?: { parts?: unknown[] } }) => c?.content?.parts ?? [])
      .find((p: { inlineData?: unknown }) => p.inlineData)?.inlineData;

  if (!inlineData?.data) {
    throw new Error(`Gemini did not return inline image data: ${JSON.stringify(body)}`);
  }

  return Buffer.from(inlineData.data, "base64");
}

async function generateImageWithOpenAI(
  prompt: string,
  model: string,
  imageSize?: string,
  referenceImages: ReferenceImage[] = []
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  const base =
    process.env.OPENAI_BASE_URL?.trim()?.replace(/\/+$/, "") || "https://api.openai.com";
  const url =
    referenceImages.length > 0
      ? `${base}/v1/images/edits`
      : `${base}/v1/images/generations`;

  const size =
    imageSize?.trim() ||
    process.env.OPENAI_IMAGE_SIZE?.trim() ||
    DEFAULT_OPENAI_IMAGE_SIZE;

  let requestBody: BodyInit;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`
  };

  if (referenceImages.length > 0) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("n", "1");
    form.append("size", size);
    const imageFieldName = referenceImages.length > 1 ? "image[]" : "image";
    for (const image of referenceImages) {
      form.append(
        imageFieldName,
        new Blob([bufferToBlobPart(image.data)], { type: image.mimeType }),
        image.name
      );
    }
    if (!/^gpt-image-/i.test(model) && model !== "chatgpt-image-latest") {
      form.append("response_format", "b64_json");
    }
    requestBody = form;
  } else {
    headers["Content-Type"] = "application/json";
    const jsonBody: Record<string, unknown> = {
      model,
      prompt,
      n: 1,
      size
    };
    if (!/^gpt-image-/i.test(model) && model !== "chatgpt-image-latest") {
      jsonBody.response_format = "b64_json";
    }
    requestBody = JSON.stringify(jsonBody);
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: requestBody
  });

  const responseBody = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI API error (${res.status}): ${JSON.stringify(responseBody)}`);
  }

  const b64 = responseBody?.data?.[0]?.b64_json;
  if (!b64 || typeof b64 !== "string") {
    throw new Error(`OpenAI did not return b64_json: ${JSON.stringify(responseBody)}`);
  }

  return Buffer.from(b64, "base64");
}

async function generateImageBytes(input: {
  prompt: string;
  provider: ImageProvider;
  model: string;
  image_size?: string;
  referenceImages?: ReferenceImage[];
}): Promise<Buffer> {
  const model = resolveModelForProvider(input.provider, input.model);
  if (input.provider === "gemini") {
    return generateImageWithGemini(input.prompt, model, input.referenceImages);
  }
  return generateImageWithOpenAI(input.prompt, model, input.image_size, input.referenceImages);
}

const sharedGenerationFields = {
  prompt: z
    .string()
    .min(3)
    .describe("Text instructions for the generated image or image edit."),
  output_path: z
    .string()
    .min(1)
    .describe("Local file path where the generated image should be written."),
  /** Defaults to the current Gemini image model; OpenAI path rewrites Gemini-looking models automatically. */
  model: z
    .string()
    .default(DEFAULT_GEMINI_IMAGE_MODEL)
    .describe("Image model name. Defaults to Gemini; OpenAI provider rewrites Gemini-looking defaults automatically."),
  /** Per-call override; otherwise IMAGE_GENERATION_PROVIDER or auto from keys. */
  provider: z
    .enum(["gemini", "openai"])
    .optional()
    .describe("Optional image provider override. If omitted, env configuration decides."),
  /** OpenAI images API size (e.g. 1024x1024). Ignored for Gemini. */
  image_size: z
    .string()
    .optional()
    .describe("OpenAI image size, for example 1024x1024. Ignored by Gemini."),
  /** Optional local reference image path for image-to-image generation/editing. */
  reference_image_path: z
    .string()
    .min(1)
    .optional()
    .describe("Local reference image path. Best for Claude Code/Cursor when the image is in the workspace or user provides an absolute path."),
  /** Optional local reference image paths for image-to-image generation/editing. */
  reference_image_paths: z
    .array(z.string().min(1))
    .optional()
    .describe("Multiple local reference image paths."),
  /** Optional public reference image URL for image-to-image generation/editing. */
  reference_image_url: z
    .string()
    .url()
    .optional()
    .describe("Public reference image URL."),
  /** Optional public reference image URLs for image-to-image generation/editing. */
  reference_image_urls: z
    .array(z.string().url())
    .optional()
    .describe("Multiple public reference image URLs."),
  /** Optional base64 image data, useful when an MCP client exposes an uploaded chat image as bytes. */
  reference_image_base64: z
    .string()
    .min(1)
    .optional()
    .describe("Base64 reference image bytes. Use this only when the MCP client exposes an uploaded chat image as bytes."),
  /** Optional data URI image, e.g. data:image/png;base64,... */
  reference_image_data_uri: z
    .string()
    .min(1)
    .optional()
    .describe("Reference image data URI, for example data:image/png;base64,..."),
  /** MIME type for reference_image_base64 when it is not a data URI. */
  reference_image_mime_type: z
    .string()
    .optional()
    .describe("MIME type for reference_image_base64, for example image/png."),
  /** File name for reference_image_base64 / reference_image_data_uri. */
  reference_image_name: z
    .string()
    .optional()
    .describe("File name for reference_image_base64 or reference_image_data_uri."),
  /** Optional MCP-style image object: { type: "image", data, mimeType }. */
  reference_image: z
    .object({
      type: z.string().optional(),
      data: z.string().min(1).optional(),
      base64: z.string().min(1).optional(),
      data_uri: z.string().min(1).optional(),
      mimeType: z.string().optional(),
      mime_type: z.string().optional(),
      name: z.string().optional()
    })
    .optional()
    .describe("MCP-style image object, usually { type: 'image', data: base64, mimeType: 'image/png' }. Useful if Claude/Cursor passes an uploaded chat image into tool arguments."),
  /** Optional list of MCP-style image objects. */
  reference_images: z
    .array(
      z.object({
        type: z.string().optional(),
        data: z.string().min(1).optional(),
        base64: z.string().min(1).optional(),
        data_uri: z.string().min(1).optional(),
        mimeType: z.string().optional(),
        mime_type: z.string().optional(),
        name: z.string().optional()
      })
    )
    .optional()
    .describe("Multiple MCP-style image objects."),
  mcp_api_key: z.string().optional().describe("Optional MCP-level auth key when MCP_STATIC_API_KEY is configured.")
};

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
  form.append("image", new Blob([bufferToBlobPart(data)], { type: mimeType }), fileName);

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
    version: packageJsonVersion()
  });

  server.tool(
    "generate_image",
    "Generate an image via Gemini or OpenAI and save it to disk. Supports reference images from local paths, public URLs, base64/data URIs, or MCP-style image objects when a client such as Claude or Cursor exposes uploaded chat images to tool arguments.",
    sharedGenerationFields,
    async (input) => {
      assertMcpApiKey(input.mcp_api_key);
      const provider = resolveImageProvider(input.provider);
      const referenceImages = await loadReferenceImages(input);
      const image = await generateImageBytes({
        prompt: input.prompt,
        provider,
        model: input.model,
        image_size: input.image_size,
        referenceImages
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
        reference_images: referenceImages.map((image) => ({
          name: image.name,
          mime_type: image.mimeType,
          bytes: image.data.byteLength
        })),
        ...(provider === "openai" && input.image_size
          ? { image_size: input.image_size }
          : provider === "openai"
            ? {
                image_size:
                  process.env.OPENAI_IMAGE_SIZE?.trim() || DEFAULT_OPENAI_IMAGE_SIZE
              }
            : {})
      });
    }
  );

  server.tool(
    "upload_image",
    "Upload a local image file to an upload-public endpoint (x-api-key supported).",
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
    "Generate an image via Gemini or OpenAI, save it, then upload it. Supports reference images from local paths, public URLs, base64/data URIs, or MCP-style image objects when a client such as Claude or Cursor exposes uploaded chat images to tool arguments.",
    {
      ...sharedGenerationFields,
      endpoint: z.string().url().optional(),
      bearer_token: z.string().optional(),
      x_api_key: z.string().optional(),
      origin: z.string().optional(),
      referer: z.string().optional()
    },
    async (input) => {
      assertMcpApiKey(input.mcp_api_key);
      const provider = resolveImageProvider(input.provider);
      const referenceImages = await loadReferenceImages(input);
      const image = await generateImageBytes({
        prompt: input.prompt,
        provider,
        model: input.model,
        image_size: input.image_size,
        referenceImages
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
            model: resolveModelForProvider(provider, input.model),
            reference_images: referenceImages.map((image) => ({
              name: image.name,
              mime_type: image.mimeType,
              bytes: image.data.byteLength
            }))
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
          model: resolveModelForProvider(provider, input.model),
          reference_images: referenceImages.map((image) => ({
            name: image.name,
            mime_type: image.mimeType,
            bytes: image.data.byteLength
          }))
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
