import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cloud, Loader2, Shield } from "lucide-react";
import { signup, login, getAuthProviders, consumeTokenFragment, beginSocialLogin, type AuthProviders } from "../lib/auth";
import { ErrorBar } from "../components/ui";

// Tier B sign-in (opt-in, hosted). Email + password against the server variant's /auth/* endpoints.
// Tier A works with NO account — this screen is only reached from Settings -> "Cloud sync & always-on
// access". On success we return to Settings, where the cloud section reflects the signed-in state.
//
// Honest copy: this is NOT "private" — it's "stored on our servers so you can reach it anywhere; only
// you, signed in, can access it." NEVER imply the data is private to the device once cloud sync is on.
type Tab = "signin" | "create";

export default function SignIn() {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which sign-in providers the server enabled. Default to password-only (no social buttons) so the
  // email/password form always works even if the probe fails or social isn't configured.
  const [providers, setProviders] = useState<AuthProviders>({ password: true, google: false, facebook: false });

  const canSubmit = email.trim().length > 3 && email.includes("@") && password.length >= 8 && !busy;

  // On mount: (1) consume a `#token=<jwt>` fragment left by a social-login redirect — store it via the
  // same path login() uses, clear the fragment, and bounce to Settings; (2) otherwise probe which
  // providers are enabled so we render only the "Continue with …" buttons the server actually supports.
  useEffect(() => {
    if (consumeTokenFragment()) {
      nav("/settings/connections", { replace: true });
      return;
    }
    let alive = true;
    getAuthProviders()
      .then((p) => { if (alive) setProviders(p); })
      .catch(() => { /* default password-only — social buttons stay hidden */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hand off to the server's social-login start endpoint. Full-page navigation (not fetch): the server
  // redirects to the provider and back to /signin#token=…&nonce=…, which this page consumes on return
  // (the token is only adopted when the echoed nonce matches the one beginSocialLogin generated).
  const startOAuth = (provider: "google" | "facebook") => beginSocialLogin(provider);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      if (tab === "create") await signup(email, password);
      else await login(email, password);
      nav("/settings/connections", { replace: true });
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page fade-in">
      <div className="row" style={{ gap: 10, marginBottom: 6 }}>
        <Cloud size={20} color="var(--accent-2)" />
        <h2 style={{ margin: 0, fontSize: "var(--fs-xl)" }}>Cloud sync &amp; always-on access</h2>
      </div>
      <p className="page-sub" style={{ marginBottom: 18 }}>
        Sign in to store a copy of your memory on our servers so you can reach it from anywhere — for
        example, from an AI tool that isn't on this device. Only you, signed in, can access it.
      </p>

      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <div className="pill-toggle" role="tablist" aria-label="Sign in or create account" style={{ display: "flex", marginBottom: 16 }}>
        {(["signin", "create"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""}
            style={{ flex: 1, justifyContent: "center" }}
            onClick={() => { setTab(t); setError(null); }}>
            {t === "signin" ? "Sign in" : "Create account"}
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
          {busy ? <Loader2 size={15} style={{ animation: "spin .8s linear infinite" }} /> : <Cloud size={15} />}
          {tab === "create" ? " Create account" : " Sign in"}
        </button>
      </form>

      {(providers.google || providers.facebook) && (
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ gap: 10, alignItems: "center", margin: "0 0 12px" }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>or</span>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>
          {providers.google && (
            <button type="button" className="btn block" style={{ marginBottom: 8 }} onClick={() => startOAuth("google")}>
              Continue with Google
            </button>
          )}
          {providers.facebook && (
            <button type="button" className="btn block" onClick={() => startOAuth("facebook")}>
              Continue with Facebook
            </button>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 18, alignItems: "flex-start" }}>
        <Shield size={14} color="var(--ok)" style={{ marginTop: 2, flexShrink: 0 }} />
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Stored on our servers so you can reach it anywhere; only you, signed in, can access it. Audio
          is never uploaded or stored — only the text and memory you choose to share. Cloud sync stays
          off until you turn it on.
        </span>
      </div>
    </div>
  );
}
