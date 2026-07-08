import { useState } from "react";
import { Check, Loader2, LogIn, Shield, UserRound } from "lucide-react";
import { signup, login, signOut, isSignedIn, cachedEmail } from "../lib/auth";
import { ErrorBar } from "./ui";

// The account step (onboarding + the post-update sign-in gate). An account is REQUIRED to use
// Sutra (owner decision, docs/MONETIZATION-PLAN.md): it activates the app and manages the plan.
// Honest copy below — an account does NOT upload memory; that stays on-device unless the user
// separately opts into cloud sync. Email/password only for now (social is env-gated server-side).
type Tab = "signin" | "create";

export function AccountStep({ onSignedIn }: { onSignedIn: () => void }) {
  const [signedIn, setSignedIn] = useState<boolean>(isSignedIn);
  const [tab, setTab] = useState<Tab>("create");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 3 && email.includes("@") && password.length >= 8 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      if (tab === "create") await signup(email, password);
      else await login(email, password);
      setSignedIn(true);
      onSignedIn();
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  if (signedIn) {
    return (
      <div className="onboard-opts">
        <div className="onboard-opt sel" style={{ cursor: "default" }}>
          <div className="oo-top"><UserRound size={18} /><strong>{cachedEmail() || "Signed in"}</strong><Check size={16} className="oo-check" /></div>
          <div className="oo-desc">You're signed in — continue to set up Sutra.</div>
        </div>
        <button className="btn ghost block" style={{ marginTop: 8 }}
          onClick={() => { signOut(); setSignedIn(false); setError(null); }}>
          Use a different account
        </button>
      </div>
    );
  }

  return (
    <div style={{ textAlign: "left" }}>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <div className="pill-toggle" role="tablist" aria-label="Create account or sign in" style={{ display: "flex", marginBottom: 14 }}>
        {(["create", "signin"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""}
            style={{ flex: 1, justifyContent: "center" }}
            onClick={() => { setTab(t); setError(null); }}>
            {t === "create" ? "Create account" : "Sign in"}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="field"><span>Email</span>
          <input className="input" type="email" autoComplete="email" inputMode="email"
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        <label className="field"><span>Password</span>
          <input className="input" type="password"
            autoComplete={tab === "create" ? "new-password" : "current-password"}
            value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
        </label>
        <button type="submit" className="btn primary block" disabled={!canSubmit}>
          {busy ? <Loader2 size={15} style={{ animation: "spin .8s linear infinite" }} /> : <LogIn size={15} />}
          {tab === "create" ? " Create account" : " Sign in"}
        </button>
      </form>

      <div className="row" style={{ gap: 8, marginTop: 14, alignItems: "flex-start" }}>
        <Shield size={14} color="var(--ok)" style={{ marginTop: 2, flexShrink: 0 }} />
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Your account activates Sutra and manages your plan. Your memory stays on your device — an
          account does not upload anything. If you later turn on cloud sync, we store a copy you can
          delete from Settings at any time.
        </span>
      </div>
    </div>
  );
}

/** Full-screen sign-in gate for installs that are already onboarded but have no account session
 *  (app update path, expired token, signed out). Local memory is untouched behind this gate. */
export function AccountGate({ onDone }: { onDone: () => void }) {
  return (
    <div className="onboard">
      <div className="onboard-body">
        <div className="onboard-icon"><UserRound size={38} /></div>
        <h1>Sign in to continue</h1>
        <p className="onboard-sub">Your memory is safe on this device. Sign in to keep using Sutra.</p>
        <AccountStep onSignedIn={onDone} />
      </div>
    </div>
  );
}
