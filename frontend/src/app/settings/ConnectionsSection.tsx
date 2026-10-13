import { useCallback, useEffect, useState } from "react";
import { Copy, Eye, EyeOff, FolderOpen, RefreshCw } from "lucide-react";
import { desktop, type McpClientId, type McpClientStatus, type McpServerStatus, type McpWriteResult } from "../../desktop/bridge";
import { getMcpBridgeStatus, restartMcpBridge } from "../../lib/mcpBridge";
import { friendlyError } from "../ui";
import { copy, Group, Row, RowMenu, Status, SwitchRow, type SectionProps } from "./kit";

// Connections (MCP): let the user's own AI tools — Claude Code, Codex, Cursor, Gemini CLI, Claude
// Desktop — read Sutra's memory through the local MCP server (mcp-server/). The app dials OUT to that
// server with the pairing token (lib/mcpBridge.ts); each tool launches the server itself. On desktop
// we can set each tool up in one click (electron/mcpConnect.ts); everywhere we show the exact config.

/** 64-char hex pairing token from the CSPRNG. Never logged; shown only behind Reveal. */
function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const SCOPES: { key: string; title: string; desc: string }[] = [
  { key: "mcp_allow_transcripts", title: "Transcripts", desc: "The cleaned-up text of your meetings." },
  { key: "mcp_allow_people", title: "People", desc: "The names you've added — never voices." },
  { key: "mcp_allow_graph", title: "Connections between things", desc: "People, projects and topics, and how they relate." },
  { key: "mcp_allow_priors", title: "Your context", desc: "Only the beliefs you marked Shared. Sent as beliefs, not facts." },
];

function bridgeLabel(state: string): { kind?: "ok" | "err"; text: string } {
  if (state === "connected") return { kind: "ok", text: "Connected" };
  if (state === "auth_failed") return { kind: "err", text: "Pairing failed" };
  if (state === "error") return { kind: "err", text: "Connection problem" };
  return { text: "Waiting for an AI tool" }; // the server only runs while a tool has it open
}

export function ConnectionsSection({ settings, put, toast }: SectionProps) {
  const enabled = settings["mcp_enabled"] === true;
  const token = String(settings["mcp_token"] ?? "");
  const url = String(settings["mcp_bridge_url"] ?? "");
  const [reveal, setReveal] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [bridge, setBridge] = useState(getMcpBridgeStatus);
  const [urlDraft, setUrlDraft] = useState(url);

  // The bridge state is in-memory; a cheap poll keeps the status line live while the sheet is open.
  useEffect(() => {
    const t = setInterval(() => setBridge(getMcpBridgeStatus()), 1500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setUrlDraft(url), [url]);

  // Every mcp_* change saves, then restarts the bridge so it takes effect immediately.
  const save = async (patch: Record<string, unknown>) => {
    await put(patch);
    await restartMcpBridge().catch(() => {});
    setBridge(getMcpBridgeStatus());
  };
  const toggle = (on: boolean) => void save(on ? (token ? { mcp_enabled: true } : { mcp_enabled: true, mcp_token: newToken() }) : { mcp_enabled: false });
  const rotate = () => { setRotating(false); void save({ mcp_token: newToken() }).then(() => toast("New pairing token — reconnect your tools")); };

  const status = bridgeLabel(bridge.state);

  return (
    <>
      <Group hint={enabled ? undefined : "Read-only. Nothing leaves this device until you turn this on and connect a tool; audio never exists to share."}>
        <SwitchRow title="Share with AI tools" desc={`Let AI tools you run on ${desktop ? "this" : "your"} computer read your meetings and notes, over a private, paired connection.`}
          checked={enabled} onChange={toggle} />
        {enabled && (
          <Row title="Status" desc={bridge.state === "auth_failed" ? "A tool used an old pairing token. Reconnect it below." : bridge.state === "connected" ? "An AI tool is reading from Sutra." : "Starts when one of your AI tools does."}>
            <Status kind={status.kind}>{status.text}</Status>
          </Row>
        )}
      </Group>

      {enabled && (
        <>
          {desktop?.mcp ? <DesktopTools token={token} url={url} reveal={reveal} toast={toast} /> : (
            <Group label="Connect" hint={<>Run the Sutra MCP server on your computer with this token (see <code>mcp-server/README.md</code>), then keep this app open. Over USB, run <code>adb reverse tcp:8765 tcp:8765</code> first.</>}>
              <Row className="stack" title="Connection address" desc="Where your computer's MCP server listens.">
                <input type="text" value={urlDraft} placeholder="ws://localhost:8765" aria-label="Connection address" style={{ maxWidth: "none" }}
                  onChange={(e) => setUrlDraft(e.target.value)} onBlur={() => { if (urlDraft !== url) void save({ mcp_bridge_url: urlDraft.trim() }); }} />
              </Row>
            </Group>
          )}

          <Group label="Pairing token" hint="Your AI tools prove they're yours with this token. A new one disconnects every tool until you reconnect it.">
            <Row title={<span className="set-token">{reveal ? token : "•".repeat(32)}</span>}>
              <div className="actions">
                <button className="icon-btn ghost sm" onClick={() => setReveal((v) => !v)} aria-label={reveal ? "Hide token" : "Reveal token"}>{reveal ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                <button className="icon-btn ghost sm" onClick={() => void copy(token).then((ok) => toast(ok ? "Token copied" : "Couldn't copy"))} aria-label="Copy token"><Copy size={16} /></button>
              </div>
            </Row>
            {rotating ? (
              <Row title="Make a new token?" desc="Every connected tool stops working until you reconnect it.">
                <div className="actions">
                  <button className="btn sm" onClick={() => setRotating(false)}>Cancel</button>
                  <button className="btn sm danger" onClick={rotate}>New token</button>
                </div>
              </Row>
            ) : (
              <Row title="New token" desc="If you think someone else has it.">
                <button className="btn sm" onClick={() => setRotating(true)}><RefreshCw size={14} /> New token</button>
              </Row>
            )}
          </Group>

          <Group label="What AI tools can read">
            {SCOPES.map((s) => (
              <SwitchRow key={s.key} title={s.title} desc={s.desc} checked={settings[s.key] !== false} onChange={(v) => void save({ [s.key]: v })} />
            ))}
          </Group>
        </>
      )}
    </>
  );
}

/** Desktop: one row per AI tool, with one-click setup and the exact snippet it writes. */
function DesktopTools({ token, url, reveal, toast }: { token: string; url: string; reveal: boolean; toast: (m: string) => void }) {
  const mcp = desktop!.mcp!;
  const [server, setServer] = useState<McpServerStatus | null>(null);
  const [clients, setClients] = useState<McpClientStatus[]>([]);
  const [open, setOpen] = useState<McpClientId | "other" | null>(null);
  const [snippet, setSnippet] = useState("");
  const [result, setResult] = useState<{ id: McpClientId; r: McpWriteResult } | null>(null);
  const [busy, setBusy] = useState<McpClientId | null>(null);

  const refresh = useCallback(async () => {
    const s = await mcp.status(token);
    setServer(s.server);
    setClients(s.clients);
  }, [mcp, token]);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void mcp.snippet(open, token, url).then(setSnippet).catch(() => setSnippet(""));
  }, [open, token, url, mcp]);

  const run = async (id: McpClientId, fn: () => Promise<McpWriteResult>) => {
    setBusy(id);
    try {
      const r = await fn();
      setResult({ id, r });
      setOpen(null);
      toast(r.message);
    } catch (e) {
      toast(friendlyError(e));
      setOpen(id); // show the snippet so it can be added by hand
    } finally {
      setBusy(null);
      void refresh().catch(() => {});
    }
  };
  const mask = (s: string) => (reveal ? s : s.split(token).join("•".repeat(12)));
  const panel = (id: McpClientId | "other", c?: McpClientStatus) => (
    <div className="set-row stack" key={`${id}-panel`}>
      <div className="d">
        {c?.format === "claude-cli" ? "Run this in a terminal:" : c ? <>Add this to <code>{c.configPath}</code>:</> : "Add this server to your MCP client's config:"}
      </div>
      <pre className="set-code">{mask(snippet)}</pre>
      <div className="actions">
        <button className="btn sm" onClick={() => void copy(snippet).then((ok) => toast(ok ? "Copied" : "Couldn't copy"))}><Copy size={14} /> Copy</button>
      </div>
    </div>
  );

  return (
    <Group label="Your AI tools" hint={server?.ready === false ? server.hint : "Sutra adds itself to the tool's settings and keeps a backup of the file it changes. Restart the tool afterwards."}>
      {clients.map((c) => {
        const state = c.configured === "yes" ? { kind: "ok" as const, text: "Set up" } : null;
        const done = result?.id === c.id ? result.r : null;
        return [
          <Row key={c.id} title={c.label}
            desc={done?.written ? <>Wrote <code>{done.path}</code>{done.backup && <> · backup <code>{done.backup.split(/[\\/]/).pop()}</code></>}</>
              : c.configured === "stale" ? "Set up with an older pairing token." : !c.detected ? "Not found on this computer." : c.configured === "yes" ? "Can read your Sutra memory." : "Not set up yet."}>
            <div className="actions">
              {state && <Status kind={state.kind}>{state.text}</Status>}
              {c.configured !== "yes" && (
                <button className="btn sm" disabled={busy === c.id || !server?.ready} onClick={() => void run(c.id, () => mcp.install(c.id, token, url))}>
                  {busy === c.id ? "Connecting…" : c.configured === "stale" ? "Update" : "Connect"}
                </button>
              )}
              <RowMenu label={`${c.label} options`} items={[
                { label: open === c.id ? "Hide setup" : "Show setup", onSelect: () => setOpen(open === c.id ? null : c.id) },
                ...(c.configured !== "no" ? [{ label: "Reveal config file", icon: <FolderOpen size={15} />, onSelect: () => void mcp.reveal(c.configPath) }] : []),
                ...(c.configured !== "no" ? [{ label: "Disconnect", danger: true, onSelect: () => void run(c.id, () => mcp.remove(c.id)) }] : []),
              ]} />
            </div>
          </Row>,
          open === c.id ? panel(c.id, c) : null,
        ];
      })}
      <Row title="Another MCP client" desc="Anything that takes a standard mcpServers config.">
        <button className="btn sm" onClick={() => setOpen(open === "other" ? null : "other")}>{open === "other" ? "Hide" : "Show setup"}</button>
      </Row>
      {open === "other" && panel("other")}
    </Group>
  );
}
