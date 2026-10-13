#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.js";
import { buildServer } from "./server.js";

// stdout is sacred — it carries JSON-RPC frames only. ALL logging goes to stderr.

async function main(): Promise<void> {
  const token = process.env.SUTRA_MCP_TOKEN;
  if (!token) {
    console.error(
      "[sutra-mcp] SUTRA_MCP_TOKEN is required.\n" +
        "  1. In Sutra, open Settings → Connections and turn on \"Share with AI tools\".\n" +
        "  2. Reveal the pairing token and copy it.\n" +
        "  3. Run this server with SUTRA_MCP_TOKEN set to that token, e.g.\n" +
        "       SUTRA_MCP_TOKEN=<token> sutra-mcp\n" +
        "     or add it under \"env\" in your MCP client config.",
    );
    process.exit(1);
  }

  const bridge = new Bridge(token);
  bridge.start();

  const server = buildServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[sutra-mcp] MCP server ready on stdio.");
}

main().catch((e) => {
  console.error("[sutra-mcp] fatal:", (e as Error)?.message ?? e);
  process.exit(1);
});
