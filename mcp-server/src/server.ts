import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "./bridge.js";

const UNREACHABLE =
  "Sutra unreachable. Open the Sutra app and turn on Settings → Connections → \"Share with AI tools\". For the phone app, also connect the device (USB: adb reverse tcp:8765 tcp:8765, or set its connection address to this machine's LAN address).";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(result: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Build the MCP server, registering every read-only tool + resource against the bridge. */
export function buildServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: "sutra-memory", version: "0.1.0" });

  // One place to call the phone and shape the MCP result. Disconnected → friendly guidance;
  // app-reported failures → surface the app's own (already-safe) message.
  async function relay(method: string, params: Record<string, unknown>): Promise<ToolResult> {
    if (!bridge.isConnected()) return err(UNREACHABLE);
    try {
      return ok(await bridge.call(method, params));
    } catch (e) {
      const m = (e as Error)?.message || "request failed";
      if (m === "phone disconnected" || m === "request timed out" || m === "failed to reach phone" || m === "pairing failed") {
        return err(UNREACHABLE);
      }
      return err(m);
    }
  }

  // --- Tools (all READ-ONLY) ---

  server.registerTool(
    "search_memory",
    {
      title: "Search memory",
      description: "Search your captured conversations and return ranked memory cards (title, summary, key facts, importance, date). Read-only.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("What to look for across your memory."),
        topN: z.number().int().min(1).max(50).default(10).describe("How many results to return."),
      },
    },
    async ({ query, topN }) => relay("search_memory", { query, topN }),
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get a conversation",
      description: "Get one conversation's details — summary, memory, participants, events, minutes, and (if shared) its turns. Read-only.",
      inputSchema: {
        id: z.number().int().describe("The conversation id."),
      },
    },
    async ({ id }) => relay("get_conversation", { id }),
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description: "List recent conversations with their summaries, importance, tags, and action counts. Read-only.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50).describe("How many conversations to list."),
      },
    },
    async ({ limit }) => relay("list_conversations", { limit }),
  );

  server.registerTool(
    "list_people",
    {
      title: "List people",
      description: "List the people known across your conversations (names, whether enrolled, notes). Read-only.",
      inputSchema: {},
    },
    async () => relay("list_people", {}),
  );

  server.registerTool(
    "get_graph_neighborhood",
    {
      title: "Explore the knowledge graph",
      description: "Explore the knowledge graph of people, projects, and topics around an entity — or get an overview if none is given. Read-only.",
      inputSchema: {
        entity: z.union([z.string(), z.number().int()]).optional().describe("Entity name or id to center on. Omit for an overview."),
        hops: z.number().int().min(0).max(3).default(2).describe("How many relationship hops to expand."),
        limit: z.number().int().min(1).max(240).default(120).describe("Max nodes to return."),
      },
    },
    async ({ entity, hops, limit }) => relay("get_graph_neighborhood", { entity, hops, limit }),
  );

  server.registerTool(
    "list_action_items",
    {
      title: "List action items",
      description: "List action items extracted from conversations, filtered by status. Read-only.",
      inputSchema: {
        status: z.enum(["open", "done", "all"]).default("open").describe("Which action items to list."),
      },
    },
    async ({ status }) => relay("list_action_items", { status }),
  );

  server.registerTool(
    "upcoming_events",
    {
      title: "Upcoming events",
      description: "List upcoming dated events extracted from conversations. Read-only.",
      inputSchema: {
        from: z.string().optional().describe("ISO start time to list events from. Defaults to now."),
        limit: z.number().int().min(1).max(50).default(50).describe("How many events to return."),
      },
    },
    async ({ from, limit }) => relay("upcoming_events", { from, limit }),
  );

  server.registerTool(
    "get_minutes",
    {
      title: "Get meeting minutes",
      description: "Get the meeting minutes for a conversation, if any were generated. Read-only.",
      inputSchema: {
        conversationId: z.number().int().describe("The conversation id."),
      },
    },
    async ({ conversationId }) => relay("get_minutes", { conversationId }),
  );

  server.registerTool(
    "get_your_context",
    {
      title: "Get the user's shared context",
      description:
        "Get the standing beliefs the user has chosen to share about people, projects, and themselves. These are user-shared beliefs that may be outdated and are not ground truth — prefer the actual conversations. Read-only.",
      inputSchema: {
        query: z.string().optional().describe("Optional topic to narrow the context to."),
        topN: z.number().int().min(1).max(20).default(8).describe("How many context items to return."),
      },
    },
    async ({ query, topN }) => relay("get_your_context", { query, topN }),
  );

  server.registerTool(
    "ask_memory",
    {
      title: "Ask your memory a question",
      description: "Ask a natural-language question and get a grounded, cited answer synthesized from your memory. Read-only.",
      inputSchema: {
        question: z.string().min(1).max(2000).describe("The question to ask."),
        history: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
          .max(10)
          .optional()
          .describe("Optional recent turns for follow-up context."),
      },
    },
    async ({ question, history }) => relay("ask_memory", { question, history }),
  );

  // NOTE: privacy and daily-rollup are exposed as RESOURCES below (not tools) — this keeps the
  // tool surface at the 10 callable memory tools (feature.md §1.3 / mcp-plan §6), while their data
  // is still reachable at sutra://privacy and sutra://daily-rollup/{day}.

  // --- Resources (addressable, read-only) ---

  server.registerResource(
    "privacy",
    "sutra://privacy",
    {
      title: "Privacy status",
      description: "The current privacy mode and audio-handling promise.",
      mimeType: "application/json",
    },
    async (uri) => {
      if (!bridge.isConnected()) throw new Error(UNREACHABLE);
      const result = await bridge.call("get_privacy", {});
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerResource(
    "conversation",
    new ResourceTemplate("sutra://conversation/{id}", { list: undefined }),
    {
      title: "Conversation",
      description: "A single conversation's details by id.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      if (!bridge.isConnected()) throw new Error(UNREACHABLE);
      const result = await bridge.call("get_conversation", { id: Number(id) });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerResource(
    "daily-rollup",
    new ResourceTemplate("sutra://daily-rollup/{day}", { list: undefined }),
    {
      title: "Daily rollup",
      description: "The daily summary for a given day (YYYY-MM-DD).",
      mimeType: "application/json",
    },
    async (uri, { day }) => {
      if (!bridge.isConnected()) throw new Error(UNREACHABLE);
      const result = await bridge.call("get_daily_rollup", { day: String(day) });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}
