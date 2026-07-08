import { useEffect, useState } from "react";
import { AlertTriangle, Gauge, Loader2, LogOut, Trash2, UserRound } from "lucide-react";
import { me, signOut, cachedEmail, deleteAccount, type AuthUser } from "../../lib/auth";
import { fetchUsage, type UsageSnapshot } from "../../lib/usage";
import { AUTH_EXPIRED_EVENT } from "../../providers/cloudProvider";
import { ErrorBar } from "../../components/ui";
import { Section } from "../../components/settingsKit";

// Settings → Account: who's signed in, this month's plan usage, sign out, delete account.
// Plan §6.4. During testing everything is free — the meter is shown so usage is never a surprise,
// with no upgrade CTA (billing ships later). Deletion is a first-class feature, not a support ticket.

function fmtMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 1 ? `${m} min` : `${Math.round(seconds)} sec`;
}

// Never headline a raw login handle (e.g. "emu…@sutra.test"). Derive a human, Title-Cased name from
// the local part of the address; fall back to "Local account" when there's nothing readable.
export function displayName(email: string | null): string {
  const local = (email ?? "").split("@")[0]?.trim();
  if (!local) return "Local account";
  const words = local.split(/[._\-+]+/).filter(Boolean);
  if (!words.length) return "Local account";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function Meter({ label, used, cap }: { label: string; used: string; cap: string | null }) {
  return (
    <div className="settings-row" style={{ cursor: "default" }}>
      <span className="settings-row-main">
        <strong>{label}</strong>
        <small>{used}{cap ? ` of ${cap} this month` : " this month · no limit"}</small>
      </span>
    </div>
  );
}

export default function AccountSettings() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Delete-account two-step: button → confirm area (password + final red button).
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    me().then((u) => { if (alive) setUser(u); })
      .catch((e) => { if (alive) setError(e?.message ?? "Couldn't load your account."); });
    fetchUsage().then((u) => { if (alive) setUsage(u); })
      .catch(() => { /* usage is best-effort — the account section still renders */ });
    return () => { alive = false; };
  }, []);

  const doSignOut = () => {
    signOut();
    // App listens for this and shows the sign-in gate (deferred if a capture is somehow live).
    try { window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT)); } catch { /* non-DOM env */ }
  };

  const doDelete = async () => {
    if (!password || busy) return;
    setBusy(true); setError(null);
    try {
      await deleteAccount(password);
      try { window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT)); } catch { /* non-DOM env */ }
    } catch (e: any) {
      setError(e?.message ?? "Couldn't delete the account.");
      setBusy(false);
    }
  };

  const email = user?.email || cachedEmail() || null;
  const name = displayName(email);

  return (
    <div className="page fade-in">
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <Section icon={<UserRound size={16} color="var(--accent-2)" />} title="Account">
        <div className="settings-row" style={{ cursor: "default" }}>
          <span className="settings-row-main">
            <strong>{name}</strong>
            <small>
              {email && <span className="trunc" style={{ display: "block" }}>{email}</span>}
              {usage?.plan_name ? `${usage.plan_name} plan — free during testing` : "Free during testing"}
            </small>
          </span>
        </div>
        <button className="settings-row" onClick={doSignOut}>
          <LogOut size={16} color="var(--accent-2)" />
          <span className="settings-row-main">
            <strong>Sign out</strong>
            <small>Your memory stays on this device</small>
          </span>
        </button>
      </Section>

      {usage?.available && (
        <Section icon={<Gauge size={16} color="var(--accent-2)" />} title="Usage this month">
          <Meter label="Audio processed"
            used={fmtMinutes(usage.audio_seconds_used ?? 0)}
            cap={usage.caps?.transcribe_seconds_month != null ? fmtMinutes(usage.caps.transcribe_seconds_month) : null} />
          <Meter label="AI assists"
            used={`${Math.round(usage.ai_calls_used ?? 0)}`}
            cap={usage.caps?.ai_calls_month != null ? `${usage.caps.ai_calls_month}` : null} />
          {usage.resets_at && (
            <div className="faint" style={{ fontSize: "var(--fs-xs)", padding: "6px 2px 0" }}>
              Resets {new Date(usage.resets_at).toLocaleDateString()}. Everything is free while Sutra is in testing.
            </div>
          )}
        </Section>
      )}

      <Section icon={<AlertTriangle size={16} color="var(--danger)" />} title="Danger zone">
        {!confirming ? (
          <button className="settings-row" onClick={() => setConfirming(true)}>
            <Trash2 size={16} color="var(--danger)" />
            <span className="settings-row-main">
              <strong>Delete my account</strong>
              <small>Deletes your account and every server-side copy, immediately</small>
            </span>
          </button>
        ) : (
          <div style={{ padding: "4px 2px" }}>
            <p className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 0 }}>
              This permanently deletes your account, plan and any cloud-synced copy of your memory —
              immediately and completely. The memory on this device is <strong>not</strong> touched.
              Enter your password to confirm.
            </p>
            <label className="field"><span>Password</span>
              <input className="input" type="password" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" />
            </label>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost" style={{ flex: 1 }} disabled={busy}
                onClick={() => { setConfirming(false); setPassword(""); }}>Cancel</button>
              <button className="btn danger" style={{ flex: 1 }}
                disabled={!password || busy} onClick={() => void doDelete()}>
                {busy ? <Loader2 size={15} style={{ animation: "spin .8s linear infinite" }} /> : <Trash2 size={15} />}
                Delete forever
              </button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
