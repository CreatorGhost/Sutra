// A tiny fake ACP agent for electron/__tests__/acp.test.ts. Behaviour via FAKE_ACP_MODE:
//   ok | permission | notify-complete | authfail | crash | hang | refuse-model | suffixed | parameterized
const mode = process.env.FAKE_ACP_MODE || "ok";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const state = { calls: [], answers: {} };
const CONTEXTS = { "claude-opus": [["300k", "1m"], "1m"], "gpt-5": [["272k", "1m"], "1m"] };
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
      return reply({ protocolVersion: 1, authMethods: [{ id: "cached_token", name: "Cached" }], agentCapabilities: { promptCapabilities: { image: mode === "images" } } });
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
          mode === "parameterized"
            // Like cursor-agent with `parameterizedModelPicker`: bare ids; the context window is its own option.
            ? { id: "model", category: "model", type: "select", currentValue: "default", options: [{ value: "default" }, { value: "claude-opus" }, { value: "gpt-5" }] }
            : mode === "suffixed"
            // Like cursor-agent: ids carry their config inline and only that exact form is accepted.
            ? { id: "model", category: "model", type: "select", currentValue: "opus[context=300k]", options: [{ value: "opus[context=300k]" }, { value: "sonnet[context=200k]" }] }
            : { id: "model", category: "model", type: "select", currentValue: "m1", options: [{ value: "m1" }, { value: "m2" }] },
        ],
      });
    case "session/set_config_option":
      if (mode === "parameterized") {
        const flagged = state.client?.clientCapabilities?._meta?.parameterizedModelPicker === true;
        if (msg.params.configId === "model") {
          if (!flagged || !CONTEXTS[msg.params.value]) return fail(`Invalid value ${msg.params.value}`);
          state.model = msg.params.value;
          // The agent's own default is the big window, so Sutra's 300K default has to be sent.
          const [choices, current] = CONTEXTS[state.model];
          return reply({ configOptions: [{ id: "context", category: "model_config", name: "Context", type: "select", currentValue: current, options: choices.map((v) => ({ value: v, name: v.toUpperCase() })) }] });
        }
        if (msg.params.configId === "context") {
          if (!CONTEXTS[state.model]?.[0].includes(msg.params.value)) return fail(`Invalid value ${msg.params.value}`);
          state.context = msg.params.value;
          return reply({ configOptions: [] });
        }
      }
      if (msg.params.configId === "model" && (mode === "refuse-model" || msg.params.value !== (mode === "suffixed" ? "opus[context=300k]" : "m2"))) return fail(`Invalid value ${msg.params.value}`);
      state[msg.params.configId] = msg.params.value;
      return reply({ configOptions: [] });
    case "session/prompt": {
      if (mode === "hang") return;
      state.blocks = msg.params.prompt.map((b) => (b.type === "image" ? `image:${b.mimeType}:${Buffer.from(b.data, "base64").length}` : b.type === "text" && b.text.length < 10 ? `text:${b.text}` : b.type));
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
