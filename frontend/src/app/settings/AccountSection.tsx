import { useEffect, useState } from "react";
import { CloudUpload, Copy, LogOut, Trash2 } from "lucide-react";
import { API_BASE, cachedEmail, deleteAccount, getMcpWrite, isSignedIn, login, me, putMcpWrite, signOut, signup, type McpWriteFlags } from "../../lib/auth";
import { lastSyncedAt, syncNow } from "../../lib/cloudSync";
import { fetchUsage, type UsageSnapshot } from "../../lib/usage";
import { AUTH_EXPIRED_EVENT } from "../../providers/cloudProvider";
import { friendlyError } from "../ui";
import { copy, Group, Row, SwitchRow, type SectionProps } from "./kit";

// Account (phone / web only — the desktop app has no accounts): sign in, plan usage, optional cloud
// sync + always-on access for AI tools, sign out, delete account. Ported from the old Settings →
// Account and the cloud half of Settings → Connections.

const WRITE_TOOLS: { key: keyof McpWriteFlags; title: string }[] = [
  { key: "mcp_write_add_fact", title: "Add facts" },
  { key: "mcp_write_correct_fact", title: "Correct facts" },
  { key: "mcp_write_add_action", title: "Add to-dos" },
  { key: "mcp_write_update_action", title: "Update to-dos" },
  { key: "mcp_write_relabel_person", title: "Rename people" },
];
const NO_WRITES: McpWriteFlags = { mcp_write_enabled: false, mcp_write_add_fact: false, mcp_write_correct_fact: false, mcp_write_add_action: false, mcp_write_update_action: false, mcp_write_relabel_person: false };

const fmtMin = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} sec`);

export function AccountSection({ settings, put, toast }: SectionProps) {
  const [email, setEmail] = useState<string | null>(isSignedIn() ? cachedEmail() : null);
  const [signedIn, setSignedIn] = useState(isSignedIn);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [writes, setWrites] = useState<McpWriteFlags | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(lastSyncedAt);
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");
  const cloud = settings["tier_b_enabled"] === true;

  const expired = () => { setSignedIn(false); setWrites(null); };
  // Confirm the stored token is still good; a stale one shows as signed out instead of failing later.
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    me().then((u) => { if (alive) setEmail(u.email); }).catch(() => { if (alive) expired(); });
    fetchUsage().then((u) => { if (alive) setUsage(u); }).catch(() => {});
    return () => { alive = false; };
  }, [signedIn]);
  useEffect(() => {
    if (!signedIn || !cloud) { setWrites(null); return; }
    let alive = true;
    getMcpWrite().then((f) => { if (alive) setWrites(f); }).catch(() => { if (alive) setWrites({ ...NO_WRITES }); });
    return () => { alive = false; };
  }, [signedIn, cloud]);

  const doSignOut = () => {
    signOut();
    expired();
    try { window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT)); } catch { /* non-DOM */ }
  };
  const doSync = async () => {
    setSyncing(true);
    try { const r = await syncNow(); setLastSync(r.synced_at || new Date().toISOString()); toast("Memory synced"); }
    catch (e) { const m = friendlyError(e); if (/session expired/i.test(m)) expired(); toast(m); }
    finally { setSyncing(false); }
  };
  const toggleWrite = async (key: keyof McpWriteFlags, v: boolean) => {
    const prev = writes ?? NO_WRITES;
    setWrites({ ...prev, [key]: v });
    try { setWrites(await putMcpWrite({ [key]: v })); }
    catch (e) { setWrites(prev); toast(friendlyError(e)); }
  };
  const doDelete = async () => {
    try { await deleteAccount(password); doSignOut(); toast("Account deleted"); }
    catch (e) { toast(friendlyError(e)); }
  };

  if (!signedIn) return <SignInForm onDone={() => { setEmail(cachedEmail()); setSignedIn(true); }} />;

  return (
    <>
      <Group label="Account">
        <Row title={email ?? "Signed in"} desc={usage?.plan_name ? `${usage.plan_name} plan — free during testing` : "Free during testing"}>
          <button className="btn sm" onClick={doSignOut}><LogOut size={14} /> Sign out</button>
        </Row>
        {usage?.available && (
          <>
            <Row title="Audio processed" desc={`${fmtMin(usage.audio_seconds_used ?? 0)}${usage.caps?.transcribe_seconds_month != null ? ` of ${fmtMin(usage.caps.transcribe_seconds_month)}` : ""} this month`} />
            <Row title="AI assists" desc={`${Math.round(usage.ai_calls_used ?? 0)}${usage.caps?.ai_calls_month != null ? ` of ${usage.caps.ai_calls_month}` : ""} this month`} />
          </>
        )}
      </Group>

      <Group label="Cloud sync" hint={cloud ? "Uploads cleaned text, people (never voices), your graph and only the context you chose to share. Audio is never included." : undefined}>
        <SwitchRow title="Sync my memory to the cloud" desc="So your AI tools can reach it from anywhere, even when this device is off. Stored on Sutra's servers; only you can access it."
          checked={cloud} onChange={(v) => void put({ tier_b_enabled: v })} />
        {cloud && (
          <>
            <Row title="Sync now" desc={lastSync ? `Last synced ${new Date(lastSync).toLocaleString()}` : "Not synced yet"}>
              <button className="btn sm" onClick={() => void doSync()} disabled={syncing}><CloudUpload size={14} /> {syncing ? "Syncing…" : "Sync"}</button>
            </Row>
            <Row title="Connector address" desc={<>Add <code>{API_BASE}/mcp</code> as a custom connector in your AI tool and sign in with this account.</>}>
              <button className="icon-btn ghost sm" aria-label="Copy connector address" onClick={() => void copy(`${API_BASE}/mcp`).then((ok) => toast(ok ? "Copied" : "Couldn't copy"))}><Copy size={16} /></button>
            </Row>
          </>
        )}
      </Group>

      {cloud && writes && (
        <Group label="AI changes to your cloud memory" hint="Every change is recorded and can be undone.">
          <SwitchRow title="Allow AI to update my memory" desc="Lets a connected AI tool make these changes during a chat." checked={writes.mcp_write_enabled} onChange={(v) => void toggleWrite("mcp_write_enabled", v)} />
          {writes.mcp_write_enabled && WRITE_TOOLS.map((t) => (
            <SwitchRow key={t.key} title={t.title} checked={writes[t.key]} onChange={(v) => void toggleWrite(t.key, v)} />
          ))}
        </Group>
      )}

      <Group label="Delete account">
        {!deleting ? (
          <Row title="Delete my account" desc="Deletes your account, plan and any cloud copy immediately. Notes on this device stay.">
            <button className="btn sm danger" onClick={() => setDeleting(true)}><Trash2 size={14} /> Delete…</button>
          </Row>
        ) : (
          <Row title={<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" aria-label="Password" />}
            desc="Enter your password to delete your account for good.">
            <div className="actions">
              <button className="btn sm" onClick={() => { setDeleting(false); setPassword(""); }}>Cancel</button>
              <button className="btn sm danger" disabled={!password} onClick={() => void doDelete()}>Delete forever</button>
            </div>
          </Row>
        )}
      </Group>
    </>
  );
}

function SignInForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"signin" | "create">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = email.includes("@") && email.trim().length > 3 && password.length >= 8 && !busy;
  const submit = async () => {
    if (!ok) return;
    setBusy(true); setError(null);
    try { await (mode === "create" ? signup(email, password) : login(email, password)); onDone(); }
    catch (e) { setError(friendlyError(e)); }
    finally { setBusy(false); }
  };
  return (
    <Group label="Account" hint={error ?? "An account is only needed for cloud sync and your plan. Your notes stay on this device."}>
      <Row title={mode === "create" ? "Create an account" : "Sign in"}>
        <div className="mini-seg">
          <button aria-pressed={mode === "signin"} onClick={() => setMode("signin")}>Sign in</button>
          <button aria-pressed={mode === "create"} onClick={() => setMode("create")}>Create</button>
        </div>
      </Row>
      <form className="set-row stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="set-field two">
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email" />
          <input type="password" autoComplete={mode === "create" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+ characters)" aria-label="Password" />
        </div>
        <div className="actions"><button type="submit" className="btn sm primary" disabled={!ok}>{busy ? "…" : mode === "create" ? "Create account" : "Sign in"}</button></div>
      </form>
    </Group>
  );
}
