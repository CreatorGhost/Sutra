import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plug, CloudUpload, Check, Loader2, Eye, EyeOff, Copy, RefreshCw, LogOut, Lock } from "lucide-react";
import { api } from "../../local/sutra";
import { restartMcpBridge, getMcpBridgeStatus } from "../../lib/mcpBridge";
import { Chip, ErrorBar, isBenignError } from "../../components/ui";
import { tapHaptic } from "../../lib/nativeChrome";
import { isSignedIn, cachedEmail, me, signOut, API_BASE, getMcpWrite, putMcpWrite, type McpWriteFlags } from "../../lib/auth";
import { syncNow, lastSyncedAt } from "../../lib/cloudSync";
import { Section, SwitchRow } from "../../components/settingsKit";

// Cloud-write consent (Tier B). All default false (default-deny). The master gate enables the section;
// each per-tool flag is independently consented. Plain-language labels — never AI vendor/model names.
const MCP_WRITE_DEFAULTS: McpWriteFlags = {
  mcp_write_enabled: false,
  mcp_write_add_fact: false,
  mcp_write_correct_fact: false,
  mcp_write_add_action: false,
  mcp_write_update_action: false,
  mcp_write_relabel_person: false,
};
const MCP_WRITE_TOOLS: { key: keyof McpWriteFlags; label: string }[] = [
  { key: "mcp_write_add_fact", label: "Add facts" },
  { key: "mcp_write_correct_fact", label: "Correct facts" },
  { key: "mcp_write_add_action", label: "Add to-dos" },
  { key: "mcp_write_update_action", label: "Update to-dos" },
  { key: "mcp_write_relabel_person", label: "Rename people" },
];

// External access (MCP) — generate a fresh 64-char lowercase hex pairing token. Never logged; the
// only place it's rendered is the Reveal-gated row below.
function genMcpToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export default function ConnectionsSettings() {
  const navigate = useNavigate();
  const [cfg, setCfg] = useState<any>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  // External access (MCP)
  const [mcpReveal, setMcpReveal] = useState(false);
  const [mcpRotate, setMcpRotate] = useState(false);
  const [mcpStatus, setMcpStatus] = useState(getMcpBridgeStatus);
  // Cloud sync & always-on access (Tier B)
  const [signedIn, setSignedIn] = useState<boolean>(isSignedIn);
  const [accountEmail, setAccountEmail] = useState<string | null>(cachedEmail);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(lastSyncedAt);
  // Cloud-write consent flags (default-deny). Loaded from /settings/mcp-write once the section is in
  // scope (signed in AND tier_b_enabled); null until then. Toggles are optimistic with rollback.
  const [writeFlags, setWriteFlags] = useState<McpWriteFlags | null>(null);
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(null), 2500); };

  // Poll the bridge connection state every 2s while Settings is mounted (cheap; reads in-memory state).
  useEffect(() => {
    setMcpStatus(getMcpBridgeStatus());
    const t = setInterval(() => setMcpStatus(getMcpBridgeStatus()), 2000);
    return () => clearInterval(t);
  }, []);

  const reload = async () => {
    const [c] = await Promise.allSettled([api.getSettings()]);
    if (c.status === "fulfilled") setCfg(c.value);
    const fatal = [c].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    if (fatal && !isBenignError(fatal.reason?.message ?? String(fatal.reason))) {
      setError(fatal.reason?.message ?? String(fatal.reason));
    }
    setLoading(false);
  };
  useEffect(() => { reload().catch((e) => { setError(e.message); setLoading(false); }); }, []);

  const save = async (patch: Record<string, unknown>) => {
    const prev = cfg;
    setCfg((c: any) => ({ ...c, ...patch }));
    try { await api.putSettings(patch); setSaved(true); setTimeout(() => setSaved(false), 1500); }
    catch (e: any) { setCfg(prev); setError(e.message); }
  };

  // External access (MCP) — every mcp_* change saves then nudges the bridge. mcpSave generates a
  // token alongside the patch on first enable so it lands in the same write (no separate round-trip).
  const mcpSave = async (patch: Record<string, unknown>) => {
    await save(patch);
    restartMcpBridge().catch(() => {});
  };
  const toggleMcp = (on: boolean) => {
    if (on) mcpSave(cfg.mcp_token ? { mcp_enabled: true } : { mcp_enabled: true, mcp_token: genMcpToken() });
    else mcpSave({ mcp_enabled: false });
  };
  const rotateMcpToken = () => { setMcpRotate(false); mcpSave({ mcp_token: genMcpToken() }); flash("Pairing token rotated."); };
  const copyMcpToken = async () => {
    const tok = String(cfg.mcp_token || "");
    if (!tok) return;
    try { await navigator.clipboard.writeText(tok); flash("Token copied."); }
    catch {
      // Clipboard API unavailable (insecure context / old WebView) — fall back to a hidden textarea.
      try {
        const ta = document.createElement("textarea");
        ta.value = tok; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
        flash("Token copied.");
      } catch { setMcpReveal(true); flash("Copy unavailable — reveal and copy manually."); }
    }
  };

  // --- Cloud sync & always-on access (Tier B) ---
  // Master toggle is local-only (cfg.tier_b_enabled, default OFF). Turning it on doesn't push anything;
  // it just reveals the cloud controls. Sign-in lives on its own route; sync is an explicit button.
  // Confirm the stored token is still valid when the section is in scope so a stale/expired token shows
  // as signed-out rather than silently 401-ing on sync.
  useEffect(() => {
    if (!isSignedIn()) { setSignedIn(false); return; }
    let alive = true;
    me().then((u) => { if (alive) { setSignedIn(true); setAccountEmail(u.email); } })
        .catch(() => { if (alive) { setSignedIn(false); setAccountEmail(cachedEmail()); } });
    return () => { alive = false; };
  }, [cfg.tier_b_enabled]);

  // Load write-consent flags only once the section is actually visible (signed in AND Tier B on). When
  // the section leaves scope (signed out / Tier B off) we drop the cached flags so a future visit re-reads
  // them fresh rather than showing a stale snapshot. Default-deny on any read failure.
  useEffect(() => {
    if (!signedIn || cfg.tier_b_enabled !== true) { setWriteFlags(null); return; }
    let alive = true;
    getMcpWrite()
      .then((f) => { if (alive) setWriteFlags(f); })
      .catch((e: any) => {
        if (!alive) return;
        const msg = String(e?.message ?? e);
        if (/session expired/i.test(msg)) { setSignedIn(false); }
        // Default-deny: if we can't read the flags, show everything off rather than guessing enabled.
        setWriteFlags({ ...MCP_WRITE_DEFAULTS });
      });
    return () => { alive = false; };
  }, [signedIn, cfg.tier_b_enabled]);

  // Optimistic per-flag toggle with rollback on error (mirrors save()). Turning the master off does not
  // clear the per-tool flags server-side — they simply have no effect until the master is back on (the
  // server still requires master AND per-tool per write).
  const toggleWriteFlag = async (key: keyof McpWriteFlags, value: boolean) => {
    const prev = writeFlags ?? { ...MCP_WRITE_DEFAULTS };
    setError(null);
    setWriteFlags({ ...prev, [key]: value });
    try {
      const merged = await putMcpWrite({ [key]: value });
      setWriteFlags(merged);
    } catch (e: any) {
      setWriteFlags(prev); // rollback
      const msg = String(e?.message ?? e);
      if (/session expired/i.test(msg)) { setSignedIn(false); }
      setError(msg);
    }
  };

  const doSignOut = () => { signOut(); setSignedIn(false); setAccountEmail(null); setWriteFlags(null); flash("Signed out of cloud sync."); };
  const doSyncNow = async () => {
    setSyncing(true); setError(null);
    try {
      const r = await syncNow();
      setLastSync(r.synced_at || new Date().toISOString());
      flash("Memory synced.");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/session expired/i.test(msg)) { setSignedIn(false); }
      setError(msg);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="page fade-in">
      <p className="page-sub">{notice ? <span className="chip ok"><Check size={12} /> {notice}</span> : saved ? <span className="chip ok"><Check size={12} /> saved</span> : "Let your AI tools reach your memory."}</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      {loading && (
        <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 140 }} />)}</div>
      )}

      {!loading && (<>
      <div className="faint" style={{ fontSize: "var(--fs-xs)", marginBottom: 12 }}>Two ways to share: a paired tool on this computer, or the cloud so it works from anywhere.</div>

      <Section icon={<Plug size={16} color="var(--accent-2)" />} title="External access">
        <SwitchRow
          label="Share memory with your AI tools"
          caption="An AI tool on your computer can read your memory over a local, paired connection. Off by default; nothing is shared until you pair it. Audio never exists to share."
          checked={cfg.mcp_enabled === true}
          onChange={toggleMcp}
        />

        {cfg.mcp_enabled === true && (<>
          <div className="divider" />
          <div className="field">
            <div className="between"><span>Pairing token</span>
              {(() => {
                const s = mcpStatus.state;
                const label = s === "connected" ? "Connected" : s === "connecting" ? "Connecting" : s === "auth_failed" ? "Pairing failed" : s === "error" ? "Connection problem" : "Off";
                const kind = s === "connected" ? "ok" : (s === "auth_failed" || s === "error") ? "danger" : "";
                return <Chip kind={kind}>{label}</Chip>;
              })()}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 6, alignItems: "center" }}>
              <code className="input trunc" style={{ flex: 1, fontSize: "var(--fs-s)", padding: "9px 12px" }}>
                {mcpReveal ? String(cfg.mcp_token || "") : "••••••••••••••••••••••••"}
              </code>
              <button className="btn ghost sm" onClick={() => setMcpReveal((v) => !v)} aria-label={mcpReveal ? "Hide token" : "Reveal token"}>
                {mcpReveal ? <EyeOff size={14} /> : <Eye size={14} />} {mcpReveal ? "Hide" : "Reveal"}
              </button>
              <button className="btn ghost sm" onClick={copyMcpToken}><Copy size={14} /> Copy</button>
            </div>
            <div className="row" style={{ gap: 7, flexWrap: "wrap", marginTop: 8 }}>
              {mcpRotate
                ? <><button className="btn danger sm" onClick={rotateMcpToken}><RefreshCw size={14} /> Confirm rotate</button>
                    <button className="btn sm" onClick={() => setMcpRotate(false)}>Cancel</button></>
                : <button className="btn ghost sm" onClick={() => { void tapHaptic(); setMcpRotate(true); }}><RefreshCw size={14} /> Rotate</button>}
            </div>
            <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 8, display: "block" }}>Paste this into your AI tool to pair it. Rotating it unpairs anything currently connected.</span>
          </div>

          <label className="field"><span>Connection address</span>
            <input className="input" value={cfg.mcp_bridge_url ?? ""} placeholder="ws://localhost:8765"
              onChange={(e) => setCfg({ ...cfg, mcp_bridge_url: e.target.value })}
              onBlur={(e) => mcpSave({ mcp_bridge_url: e.target.value })} />
            <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 6, display: "block" }}>Where to reach the tool on your computer. The default works when the device is tethered over USB.</span>
          </label>

          <div className="divider" />
          <div className="faint" style={{ fontSize: "var(--fs-xs)", marginBottom: 8 }}>What this tool can read</div>
          <SwitchRow label="Transcripts" caption="The cleaned-up text of your conversations." checked={cfg.mcp_allow_transcripts !== false} onChange={(checked) => mcpSave({ mcp_allow_transcripts: checked })} />
          <SwitchRow label="People" caption="The names you've added — never voiceprints." checked={cfg.mcp_allow_people !== false} onChange={(checked) => mcpSave({ mcp_allow_people: checked })} />
          <SwitchRow label="Graph" caption="The people, projects and topics in your world and how they connect." checked={cfg.mcp_allow_graph !== false} onChange={(checked) => mcpSave({ mcp_allow_graph: checked })} />
          <SwitchRow label="Your Context" caption="Beliefs you chose to share about your world. These are beliefs, not facts." checked={cfg.mcp_allow_priors !== false} onChange={(checked) => mcpSave({ mcp_allow_priors: checked })} />
        </>)}
      </Section>

      <Section icon={<CloudUpload size={16} color="var(--accent-2)" />} title="Cloud sync & always-on access">
        <SwitchRow
          label="Sync my memory to the cloud"
          caption="Store your memory on our servers so your AI tools can reach it anywhere — even when this device is off. Off by default. Only you, signed in, can access it. Stored on our servers (not private to this device); audio is never stored."
          checked={cfg.tier_b_enabled === true}
          onChange={(checked) => save({ tier_b_enabled: checked })}
        />

        {cfg.tier_b_enabled === true && (<>
          <div className="divider" />
          {!signedIn ? (
            <div className="field">
              <div className="between"><span>Account</span><Chip>Signed out</Chip></div>
              <span className="faint" style={{ fontSize: "var(--fs-xs)", margin: "6px 0 8px", display: "block" }}>
                Sign in to create your private cloud space. Your memory only leaves this device once you sign in and sync.
              </span>
              <button className="btn primary sm" onClick={() => navigate("/signin")}><Lock size={14} /> Sign in</button>
            </div>
          ) : (<>
            <div className="field">
              <div className="between"><span>Account</span><Chip kind="ok">Signed in</Chip></div>
              <div className="row" style={{ gap: 8, marginTop: 6, alignItems: "center" }}>
                <code className="input trunc" style={{ flex: 1, fontSize: "var(--fs-s)", padding: "9px 12px" }}>{accountEmail || "signed in"}</code>
                <button className="btn ghost sm" onClick={doSignOut}><LogOut size={14} /> Sign out</button>
              </div>
            </div>

            <div className="field">
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <button className="btn primary sm" onClick={doSyncNow} disabled={syncing}>
                  {syncing ? <Loader2 size={14} style={{ animation: "spin .8s linear infinite" }} /> : <CloudUpload size={14} />} {syncing ? "Syncing…" : "Sync my memory now"}
                </button>
                {lastSync && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Last synced {new Date(lastSync).toLocaleString()}</span>}
              </div>
              <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 8, display: "block" }}>
                Uploads a copy of your memory — cleaned text, people (never voiceprints), your graph, and only the context you chose to share. Audio is never included.
              </span>
            </div>

            <label className="field"><span>Connector address</span>
              <div className="row" style={{ gap: 8, marginTop: 6, alignItems: "center" }}>
                <code className="input trunc" style={{ flex: 1, fontSize: "var(--fs-s)", padding: "9px 12px" }}>{API_BASE}/mcp</code>
                <button className="btn ghost sm" onClick={() => { navigator.clipboard?.writeText(`${API_BASE}/mcp`); flash("Connector address copied."); }}><Copy size={14} /> Copy</button>
              </div>
              <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 6, display: "block" }}>Add this as a custom connector in your AI tool and sign in with the same account. Works from anywhere — no cable, no same network.</span>
            </label>
          </>)}

          {signedIn && (<>
            <div className="divider" />
            <SwitchRow
              label="Allow AI to update my memory"
              caption="When on, an AI tool you've connected can make these changes to your cloud memory during a chat. Every change is recorded and reversible. Off by default."
              checked={writeFlags?.mcp_write_enabled === true}
              disabled={writeFlags == null}
              onChange={(checked) => toggleWriteFlag("mcp_write_enabled", checked)}
            />
            {writeFlags?.mcp_write_enabled === true && (
              <div style={{ marginTop: 4 }}>
                {MCP_WRITE_TOOLS.map((t) => (
                  <SwitchRow
                    key={t.key}
                    label={t.label}
                    checked={writeFlags?.[t.key] === true}
                    disabled={writeFlags == null}
                    onChange={(checked) => toggleWriteFlag(t.key, checked)}
                  />
                ))}
              </div>
            )}
          </>)}
        </>)}
      </Section>
      </>)}
    </div>
  );
}
