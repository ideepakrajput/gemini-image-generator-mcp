# Gemini Image Generator MCP

`gemini-image-generator-mcp` is a Model Context Protocol (MCP) server focused on Gemini image generation with optional upload support.

It provides 3 tools:
- `generate_image`: create an image with Gemini and save to local disk
- `upload_image`: upload a local image to your API endpoint
- `generate_and_upload`: generate and upload in one call

## Requirements

- Node.js `>= 20`
- A valid `GEMINI_API_KEY`
- Upload API is optional (needed only if you want public URLs)

## Environment

Create your env file:

```bash
cp .env.example .env
```

Set values:
- `GEMINI_API_KEY` (required)
- `UPLOAD_ENDPOINT` (optional)
- `UPLOAD_X_API_KEY` (recommended)
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
- args: `["-y", "gemini-image-generator-mcp"]`

Example config:

```json
{
  "gemini_upload_mcp": {
    "command": "npx",
    "args": ["-y", "gemini-image-generator-mcp"],
    "env": {
      "GEMINI_API_KEY": "your_google_ai_studio_key",
      "UPLOAD_ENDPOINT": "https://your-domain.com/api/upload-public",
      "UPLOAD_X_API_KEY": "your_upload_static_api_key",
      "MCP_STATIC_API_KEY": "your_mcp_static_key"
    }
  }
}
```

## Tool Input Examples

### `generate_image`

```json
{
  "prompt": "A clean modern workspace with natural light",
  "output_path": "/tmp/workspace.png",
  "model": "gemini-3.1-flash-image-preview",
  "mcp_api_key": "your_mcp_static_key"
}
```

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
  "endpoint": "https://your-domain.com/api/upload-public",
  "x_api_key": "your_upload_static_api_key",
  "mcp_api_key": "your_mcp_static_key"
}
```

If `UPLOAD_ENDPOINT` is not provided, `generate_and_upload` will skip upload and return the local generated file path.

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
const upload = multer({ dest: "uploads/" });

app.use("/uploads", express.static(path.resolve("uploads")));

app.post("/api/upload-public", upload.single("image"), (req, res) => {
  const expectedKey = process.env.UPLOAD_X_API_KEY;
  const incomingKey = req.header("x-api-key");
  if (expectedKey && incomingKey !== expectedKey) {
    return res.status(401).json({ ok: false, message: "Invalid API key" });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, message: "No image file provided" });
  }

  const ext = path.extname(req.file.originalname || "") || ".png";
  const finalName = `${req.file.filename}${ext}`;
  const finalPath = path.join("uploads", finalName);
  fs.renameSync(req.file.path, finalPath);

  const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  const publicUrl = `${baseUrl}/uploads/${finalName}`;
  return res.json({ ok: true, publicUrl });
});

app.listen(3000, () => {
  console.log("Upload API running on http://localhost:3000");
});
```

## Security Notes

- Keep keys in env only; never hardcode secrets.
- Use HTTPS upload endpoints in production.
- Rotate static keys regularly.
