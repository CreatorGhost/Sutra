// A tiny fake ACP agent for electron/__tests__/acp.test.ts. Behaviour via FAKE_ACP_MODE:
//   ok | permission | notify-complete | authfail | crash | hang | refuse-model
const mode = process.env.FAKE_ACP_MODE || "ok";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const state = { calls: [], answers: {} };
let nextId = 1000;
const waiting = new Map();

function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((r) => waiting.set(id, r));
}

async function handle(msg) {
  if (msg.method == null) { waiting.get(msg.id)?.(msg); return; }
  state.calls.push(msg.method);
  const reply = (result) => send({ id: msg.id, result });
  const fail = (message) => send({ id: msg.id, error: { code: -32000, message } });
  switch (msg.method) {
    case "initialize":
      state.client = msg.params;
      return reply({ protocolVersion: 1, authMethods: [{ id: "cached_token", name: "Cached" }] });
    case "authenticate":
      state.auth = msg.params.methodId;
      return mode === "authfail" ? fail("Not authenticated. Run `grok login`.") : reply({});
    case "session/new":
      if (mode === "crash") { process.stderr.write("boom: not logged in\n"); process.exit(3); }
      state.cwd = msg.params.cwd;
      state.mcp = msg.params.mcpServers;
      return reply({
        sessionId: "s1",
        configOptions: [
          { id: "mode", category: "mode", type: "select", currentValue: "agent", options: [{ value: "agent" }, { value: "ask" }] },
          { id: "model", category: "model", type: "select", currentValue: "m1", options: [{ value: "m1" }, { value: "m2" }] },
        ],
      });
    case "session/set_config_option":
      if (msg.params.configId === "model" && (mode === "refuse-model" || msg.params.value !== "m2")) return fail(`Invalid value ${msg.params.value}`);
      state[msg.params.configId] = msg.params.value;
      return reply({ configOptions: [] });
    case "session/prompt": {
      if (mode === "hang") return;
      const chunk = (text) => send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "(thinking)" } } } });
      if (mode === "permission") {
        const perm = await ask("session/request_permission", { sessionId: "s1", toolCall: { toolCallId: "t1" }, options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }, { optionId: "no", kind: "reject_once", name: "Reject" }] });
        const fs = await ask("fs/read_text_file", { sessionId: "s1", path: "/etc/passwd" });
        state.answers = { permission: perm.result, fs: fs.error && fs.error.code };
      }
      chunk("{\"echo\":");
      chunk(JSON.stringify({ prompt: msg.params.prompt[0].text, state }) + "}");
      if (mode === "notify-complete") {
        send({ method: "_x.ai/session/prompt_complete", params: { sessionId: "s1", stopReason: "end_turn" } });
        return;
      }
      return reply({ stopReason: "end_turn" });
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: "nope" } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
console.log("fake agent log line that is not JSON");
