#!/usr/bin/env node
import "./env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
async function main() {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Gemini upload MCP server running (stdio).");
}
main().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
});
