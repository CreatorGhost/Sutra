import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Drives the real server over stdio: list tools/resources, then call every tool with sample args.
// Prints each result to the TEST process stdout. Exits non-zero ONLY on transport-level failure, so
// it stays useful even with no phone connected (tools will report "Phone unreachable").

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../src/index.ts");

const SAMPLE: Record<string, Record<string, unknown>> = {
  search_memory: { query: "redesign", topN: 5 },
  get_conversation: { id: 1 },
  list_conversations: { limit: 20 },
  list_people: {},
  get_graph_neighborhood: { hops: 2, limit: 50 },
  list_action_items: { status: "open" },
  upcoming_events: { limit: 10 },
  get_minutes: { conversationId: 1 },
  get_your_context: { topN: 8 },
  ask_memory: { question: "What did I commit to this week?" },
};

// privacy + daily-rollup are exposed as resources, not tools — read them via their URIs.
const RESOURCE_READS = [
  "sutra://privacy",
  `sutra://daily-rollup/${new Date().toISOString().slice(0, 10)}`,
];

async function main(): Promise<void> {
  const token = process.env.SUTRA_MCP_TOKEN || "deadbeef";

  // Spawn the server via tsx so the test runs without a prior build.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(here, "../node_modules/tsx/dist/cli.mjs"), entry],
    env: { ...process.env, SUTRA_MCP_TOKEN: token } as Record<string, string>,
  });

  const client = new Client({ name: "sutra-e2e", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`\n=== tools/list (${tools.tools.length}) ===`);
  for (const t of tools.tools) console.log(`  - ${t.name}`);
  if (tools.tools.length !== 10) {
    console.log(`\n!! expected 10 tools, got ${tools.tools.length}`);
  }

  try {
    const resources = await client.listResources();
    console.log(`\n=== resources/list (${resources.resources.length}) ===`);
    for (const r of resources.resources) console.log(`  - ${r.uri}`);
  } catch (e) {
    console.log(`\n=== resources/list ===\n  (none listed: ${(e as Error).message})`);
  }

  for (const t of tools.tools) {
    const args = SAMPLE[t.name] ?? {};
    console.log(`\n=== callTool ${t.name} ${JSON.stringify(args)} ===`);
    try {
      const res: any = await client.callTool({ name: t.name, arguments: args });
      const text = (res.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      console.log(`  isError: ${res.isError === true}`);
      console.log(`  ${text.split("\n").join("\n  ")}`);
    } catch (e) {
      console.log(`  call failed: ${(e as Error).message}`);
    }
  }

  for (const uri of RESOURCE_READS) {
    console.log(`\n=== readResource ${uri} ===`);
    try {
      const res: any = await client.readResource({ uri });
      const text = (res.contents ?? []).map((c: any) => c.text ?? `[${c.mimeType ?? "blob"}]`).join("\n");
      console.log(`  ${text.split("\n").join("\n  ")}`);
    } catch (e) {
      // A disconnected bridge throws here — expected with no phone; not a transport failure.
      console.log(`  read failed (expected if no phone): ${(e as Error).message}`);
    }
  }

  await client.close();
  console.log("\n=== e2e complete ===");
}

main().catch((e) => {
  console.error("e2e transport failure:", (e as Error)?.message ?? e);
  process.exit(1);
});
