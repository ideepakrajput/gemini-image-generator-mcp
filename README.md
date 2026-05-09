# Gemini & OpenAI Image Generator MCP

`@ideepakrajput/gemini-image-generator-mcp` is a Model Context Protocol (MCP) server for **image generation** with **Gemini** and/or **OpenAI**, plus optional upload to your API.

It provides 3 tools:

- `generate_image`: create an image and save to local disk
- `upload_image`: upload a local image to your API endpoint
- `generate_and_upload`: generate and upload in one call

`generate_image` and `generate_and_upload` also support optional reference images for image-to-image generation or editing. Pass local image paths with `reference_image_path` / `reference_image_paths`, public image URLs with `reference_image_url` / `reference_image_urls`, or uploaded chat image bytes as base64/data URI fields when your MCP client exposes them.

## Requirements

- Node.js `>= 20`
- At least one of:
  - `GEMINI_API_KEY` (Google AI Studio / Gemini API), and/or
  - `OPENAI_API_KEY` (OpenAI Images API)
- Upload API is optional (needed only if you want public URLs)

## Choosing Gemini vs OpenAI

| Situation | Behavior |
|-----------|----------|
| Only `GEMINI_API_KEY` set (legacy MCP configs) | Uses **Gemini** — same as previous versions |
| Only `OPENAI_API_KEY` set | Uses **OpenAI** |
| Both keys set | Default **`IMAGE_GENERATION_PROVIDER=auto`** picks **Gemini first** (backward compatible). Set `IMAGE_GENERATION_PROVIDER=openai` to prefer OpenAI |
| Explicit flag | `IMAGE_GENERATION_PROVIDER=gemini` or `openai` forces that backend (must have the matching key) |
| Per tool call | Optional input `provider`: `"gemini"` \| `"openai"` overrides env for that request |

When using OpenAI with the default Gemini tool `model`, the server **automatically** uses `OPENAI_IMAGE_MODEL` (default `gpt-image-2`) instead of sending a Gemini model name to OpenAI.

Gemini defaults to `gemini-3.1-flash-image-preview` (Nano Banana 2 Preview) as the balanced go-to image model. Use `gemini-3-pro-image-preview` for professional asset production and complex instructions, or `gemini-2.5-flash-image` when speed and low latency matter most.

OpenAI defaults to `gpt-image-2` as the cost-optimized choice among the non-mini GPT Image models. It has lower image output pricing than `gpt-image-1.5` and `gpt-image-1`, while remaining the current state-of-the-art image model.

## Environment

Create your env file:

```bash
cp .env.example .env
```

Set values:

- **`.env` file**: when you use a file (not only MCP `env` vars), place it in the **package root** (next to the published `package.json` / your clone root). The server loads that path using the installed package location, not the process working directory—so it works with `npx` and IDE-started MCP, same idea as other published MCP servers.
- `GEMINI_API_KEY` — optional if you only use OpenAI
- `OPENAI_API_KEY` — optional if you only use Gemini
- `IMAGE_GENERATION_PROVIDER` — optional: `auto` (default), `gemini`, or `openai`
- `OPENAI_IMAGE_MODEL` — optional, default `gpt-image-2`; use `gpt-image-1.5` or `gpt-image-1` only when you explicitly need those versions
- `OPENAI_IMAGE_SIZE` — optional, default `1024x1024`
- `OPENAI_BASE_URL` — optional (compatible proxies)
- `GEMINI_IMAGE_MODEL` — optional override for Gemini default model (`gemini-3.1-flash-image-preview`)
- `UPLOAD_ENDPOINT` (optional)
- `UPLOAD_X_API_KEY` (recommended for upload)
- `MCP_STATIC_API_KEY` (optional MCP-level auth key)

When `MCP_STATIC_API_KEY` is set, include `mcp_api_key` in tool arguments.

## Local Development

```bash
npm install
npm run build
npm start
```

## Install in MCP Clients

Use `npx`:

- command: `npx`
- args: `["-y", "@ideepakrajput/gemini-image-generator-mcp"]`

### Legacy config (Gemini only — unchanged behavior)

```json
{
    "gemini_upload_mcp": {
        "command": "npx",
        "args": ["-y", "@ideepakrajput/gemini-image-generator-mcp"],
        "env": {
            "GEMINI_API_KEY": "your_google_ai_studio_key",
            "UPLOAD_ENDPOINT": "https://your-domain.com/api/upload-public",
            "UPLOAD_X_API_KEY": "your_upload_static_api_key",
            "MCP_STATIC_API_KEY": "your_mcp_static_key"
        }
    }
}
```

### OpenAI-only example

```json
{
    "gemini_upload_mcp": {
        "command": "npx",
        "args": ["-y", "@ideepakrajput/gemini-image-generator-mcp"],
        "env": {
            "OPENAI_API_KEY": "sk-...",
            "IMAGE_GENERATION_PROVIDER": "openai",
            "OPENAI_IMAGE_MODEL": "gpt-image-2",
            "OPENAI_IMAGE_SIZE": "1024x1024"
        }
    }
}
```

### Claude Desktop (`claude_desktop_config.json`)

Add this MCP server entry under `mcpServers` (same `env` shapes as above).

Example:

```json
{
    "mcpServers": {
        "gemini_image_generator": {
            "command": "npx",
            "args": ["-y", "@ideepakrajput/gemini-image-generator-mcp"],
            "env": {
                "GEMINI_API_KEY": "your_google_ai_studio_key",
                "OPENAI_API_KEY": "sk-...",
                "IMAGE_GENERATION_PROVIDER": "auto"
            }
        }
    }
}
```

### Cursor MCP config

Use the same command/args in Cursor's MCP settings:

```json
{
    "mcpServers": {
        "gemini_image_generator": {
            "command": "npx",
            "args": ["-y", "@ideepakrajput/gemini-image-generator-mcp"],
            "env": {
                "GEMINI_API_KEY": "your_google_ai_studio_key",
                "OPENAI_API_KEY": "sk-...",
                "IMAGE_GENERATION_PROVIDER": "auto"
            }
        }
    }
}
```

### Claude/Cursor reference image behavior

For best reliability in Claude Desktop, Claude Code, and Cursor, pass reference images as one of:

- `reference_image_path` when the image is on local disk
- `reference_image_url` when the image is publicly reachable
- `reference_image_base64` / `reference_image_data_uri` when the client exposes uploaded image bytes
- `reference_image` / `reference_images` for MCP-style image objects like `{ "type": "image", "data": "...base64...", "mimeType": "image/png" }`

Chat attachments are controlled by the MCP host. If Claude or Cursor does not expose the uploaded chat image to tool arguments, the MCP server cannot read it directly; provide a local path or public URL instead.

## Tool Input Examples

### `generate_image`

Gemini (legacy-style):

```json
{
    "prompt": "A clean modern workspace with natural light",
    "output_path": "/tmp/workspace.png",
    "model": "gemini-3.1-flash-image-preview",
    "mcp_api_key": "your_mcp_static_key"
}
```

OpenAI:

```json
{
    "prompt": "A clean modern workspace with natural light",
    "output_path": "/tmp/workspace.png",
    "provider": "openai",
    "model": "gpt-image-2",
    "image_size": "1024x1024",
    "mcp_api_key": "your_mcp_static_key"
}
```

With a reference image:

```json
{
    "prompt": "Use the reference image composition, but make it a polished luxury skincare ad",
    "output_path": "/tmp/skincare-ad.png",
    "provider": "openai",
    "model": "gpt-image-2",
    "image_size": "1024x1024",
    "reference_image_path": "/tmp/reference.png",
    "mcp_api_key": "your_mcp_static_key"
}
```

Multiple references and URL references are supported:

```json
{
    "prompt": "Combine the product from the first image with the background style from the second image",
    "output_path": "/tmp/composite.png",
    "reference_image_paths": ["/tmp/product.png", "/tmp/background.png"],
    "reference_image_url": "https://example.com/style-reference.jpg",
    "mcp_api_key": "your_mcp_static_key"
}
```

If your MCP client can pass an uploaded chat image as bytes, use base64 or an MCP-style image object:

```json
{
    "prompt": "Use this uploaded product image and place it in a premium studio scene",
    "output_path": "/tmp/product-scene.png",
    "reference_image_base64": "iVBORw0KGgoAAAANSUhEUg...",
    "reference_image_mime_type": "image/png",
    "reference_image_name": "uploaded-product.png",
    "mcp_api_key": "your_mcp_static_key"
}
```

```json
{
    "prompt": "Keep the same person and outfit, change the background to a clean office",
    "output_path": "/tmp/edited-upload.png",
    "reference_image": {
        "type": "image",
        "data": "iVBORw0KGgoAAAANSUhEUg...",
        "mimeType": "image/png",
        "name": "chat-upload.png"
    },
    "mcp_api_key": "your_mcp_static_key"
}
```

Important: MCP servers do not automatically receive raw files attached in a chat. The host/client must pass the upload to this tool as a local path, public URL, base64 string, data URI, or MCP-style image object.

### `upload_image`

```json
{
    "image_path": "/tmp/workspace.png",
    "endpoint": "https://your-domain.com/api/upload-public",
    "x_api_key": "your_upload_static_api_key",
    "mcp_api_key": "your_mcp_static_key"
}
```

### `generate_and_upload`

```json
{
    "prompt": "A blue abstract marketing background",
    "output_path": "/tmp/banner.png",
    "reference_image_path": "/tmp/reference.png",
    "endpoint": "https://your-domain.com/api/upload-public",
    "x_api_key": "your_upload_static_api_key",
    "mcp_api_key": "your_mcp_static_key"
}
```

If `UPLOAD_ENDPOINT` is not provided, `generate_and_upload` will skip upload and return the local generated file path.

**Paths:** `output_path` and `image_path` are written/read as you pass them. Relative paths are resolved from the **MCP process current working directory** (often your project folder), not the package install directory.

## Optional Node API for Public URL Upload

If you want public URL response after generation, create a Node upload API and set its URL in `UPLOAD_ENDPOINT`.

Install:

```bash
npm i express multer
```

Minimal server example:

```ts
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

const app = express();
const upload = multer({dest: "uploads/"});

app.use("/uploads", express.static(path.resolve("uploads")));

app.post("/api/upload-public", upload.single("image"), (req, res) => {
    const expectedKey = process.env.UPLOAD_X_API_KEY;
    const incomingKey = req.header("x-api-key");
    if (expectedKey && incomingKey !== expectedKey) {
        return res.status(401).json({ok: false, message: "Invalid API key"});
    }

    if (!req.file) {
        return res
            .status(400)
            .json({ok: false, message: "No image file provided"});
    }

    const ext = path.extname(req.file.originalname || "") || ".png";
    const finalName = `${req.file.filename}${ext}`;
    const finalPath = path.join("uploads", finalName);
    fs.renameSync(req.file.path, finalPath);

    const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
    const publicUrl = `${baseUrl}/uploads/${finalName}`;
    return res.json({ok: true, publicUrl});
});

app.listen(3000, () => {
    console.log("Upload API running on http://localhost:3000");
});
```

## Security Notes

- Keep keys in env only; never hardcode secrets.
- Use HTTPS upload endpoints in production.
- Rotate static keys regularly.
