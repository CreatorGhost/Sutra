import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Cloud, ExternalLink, Loader2, QrCode, RefreshCw, Smartphone } from "lucide-react";
import { desktop, type PairingStatus } from "../../desktop/bridge";
import type { RelaySetupState, SetupStep } from "../../shared/pairing/relaySetup";
import { friendlyError } from "../ui";
import { Group, Row, RowMenu, Status, type SectionProps } from "./kit";

// Phones (desktop only): pair the Sutra phone app with this computer. A paired phone records, then this
// computer transcribes each window with its own speech model, writes every note with its own AI engine,
// and keeps a copy of the finished meeting. Phones reach it from anywhere through the user's own
// Cloudflare relay — end-to-end encrypted, so the relay can't read anything
// (electron/pairing/*, src/shared/pairing/*).

const RELAY_DOCS = "https://github.com/CreatorGhost/Sutra/blob/dev/docs/RELAY.md";
const CF_SIGNUP = "https://dash.cloudflare.com/sign-up";

function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return "Never connected";
  const m = Math.round((now - ms) / 60_000);
  if (m < 1) return "Last seen just now";
  if (m < 60) return `Last seen ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Last seen ${h} h ago`;
  const d = Math.round(h / 24);
  return `Last seen ${d} day${d === 1 ? "" : "s"} ago`;
}

const platformLabel = (p: string) => (/android/i.test(p) ? "Android" : /ios|iphone/i.test(p) ? "iPhone" : p || "Phone");

const RELAY_STATE: Record<PairingStatus["relay"]["state"], { kind?: "ok" | "err"; text: string }> = {
  online: { kind: "ok", text: "Online" },
  connecting: { text: "Connecting…" },
  auth_failed: { kind: "err", text: "Wrong secret" },
  offline: { kind: "err", text: "Offline" },
  off: { text: "Off" },
};

export function PhonesSection({ toast }: SectionProps) {
  const pairing = desktop?.pairing;
  const [st, setSt] = useState<PairingStatus | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!pairing) return;
    void pairing.status().then(setSt).catch((e) => toast(friendlyError(e)));
    const off = pairing.onChange((u) => {
      setSt(u);
      if (u.paired) setJustPaired(u.paired.name);
    });
    // Leaving the section (or closing Settings) withdraws an open pairing code.
    return () => { off(); void pairing.cancelOffer().catch(() => {}); };
  }, [pairing]);

  if (!pairing) return <p className="muted" style={{ fontSize: 14 }}>Pairing a phone is available in the desktop app.</p>;
  if (!st) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast(friendlyError(e)); } finally { setBusy(false); }
  };
  const relayReady = st.relay.enabled && !!st.relay.url && st.relay.hasSecret;
  const newCode = () => { setJustPaired(null); void act(async () => setSt(await pairing.newOffer())); };
  const remove = (id: string) => { setRemoving(null); void act(async () => { await pairing.removeDevice(id); setSt(await pairing.status()); }); };

  return (
    <>
      <Group hint={st.sealed ? undefined : "This computer has no system keychain, so pairing keys are kept unencrypted in Sutra's data folder."}>
        {st.offer ? (
          <PairPanel offer={st.offer} busy={busy} onNew={newCode} onCancel={() => void pairing.cancelOffer()} />
        ) : justPaired ? (
          <Row title={<><Check size={15} className="phone-ok" /> {justPaired} is paired</>} desc="It now uses this computer to transcribe and write notes.">
            <button className="btn sm" onClick={newCode} disabled={busy}>Pair another</button>
          </Row>
        ) : (
          <Row title="Pair a phone" desc={relayReady
            ? "Record on your phone. This computer transcribes and writes the notes with its own engine, and keeps a copy of every meeting."
            : "Connect with Cloudflare below first — your phone reaches this computer through your relay, from any network."}>
            <button className="btn sm primary" onClick={newCode} disabled={busy || !relayReady}><QrCode size={14} /> Pair a phone</button>
          </Row>
        )}
      </Group>

      {st.devices.length > 0 && (
        <Group label="Paired phones">
          {st.devices.map((d) => removing === d.id ? (
            <Row key={d.id} title={`Remove ${d.name}?`} desc="It stops using this computer until you pair it again.">
              <div className="actions">
                <button className="btn sm" onClick={() => setRemoving(null)}>Cancel</button>
                <button className="btn sm danger" onClick={() => remove(d.id)}>Remove</button>
              </div>
            </Row>
          ) : (
            <Row key={d.id} title={<><span className="phone-glyph" aria-hidden="true"><Smartphone size={15} /></span>{d.name}</>}
              desc={<span className="phone-status">
                {d.connected ? <><i className="dot ok" />Connected now · {d.via.includes("lan") ? "same Wi-Fi" : "via your relay"}</> : ago(d.lastSeenAt)}
                <span className="set-sub">{platformLabel(d.platform)}</span>
              </span>}>
              <RowMenu label={`${d.name} options`} items={[{ label: "Remove", danger: true, onSelect: () => setRemoving(d.id) }]} />
            </Row>
          ))}
        </Group>
      )}

      <RelayCard st={st} toast={toast} onSaved={setSt} onReady={() => { if (!st.offer) newCode(); }} />
    </>
  );
}

/** The QR a phone scans, its countdown and the ways it lists to reach this computer. */
function PairPanel({ offer, busy, onNew, onCancel }: { offer: NonNullable<PairingStatus["offer"]>; busy: boolean; onNew: () => void; onCancel: () => void }) {
  const [svg, setSvg] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    void QRCode.toString(offer.link, { type: "svg", margin: 0, errorCorrectionLevel: "L", color: { dark: "#111113", light: "#ffffff" } })
      .then((s) => { if (live) setSvg(s); });
    return () => { live = false; };
  }, [offer.link]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((offer.exp - now) / 1000));
  const expired = left === 0;

  return (
    <div className="set-row pair-panel">
      <div className={`pair-qr${expired ? " expired" : ""}`} role="img" aria-label="Pairing code" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="grow pair-info">
        <div className="t">Scan with your phone</div>
        <div className="d">On your phone, open Sutra → Settings → Your Mac, tap “Scan pairing code” and point the camera at this code.</div>
        <ul className="pair-routes">
          {offer.routes.map((r) => (
            <li key={r.url}>{r.kind === "lan" ? <>Same Wi-Fi: <span className="set-token">{new URL(r.url).hostname}</span></> : <>From anywhere, through <span className="set-token">{new URL(r.url.replace(/^ws/, "http")).hostname}</span></>}</li>
          ))}
        </ul>
        <div className="pair-foot">
          <span className="set-sub">{expired ? "This code expired" : `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</span>
          <div className="actions">
            <button className="btn sm" onClick={onCancel}>Cancel</button>
            <button className="btn sm" onClick={onNew} disabled={busy}><RefreshCw size={14} /> New code</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const STEPS: { step: SetupStep; label: string }[] = [
  { step: "tools", label: "Get Cloudflare's tools ready" },
  { step: "signin", label: "Sign in to Cloudflare" },
  { step: "deploy", label: "Set up your relay" },
  { step: "secret", label: "Secure it" },
  { step: "verify", label: "Check it works" },
];

/** "Reach from anywhere": one click sets up the user's own relay on their free Cloudflare account
 *  (electron/pairing/relaySetup.ts), after ViewCode's Quick connect. A relay set up by hand still works. */
function RelayCard({ st, toast, onSaved, onReady }: { st: PairingStatus; toast: (m: string) => void; onSaved: (s: PairingStatus) => void; onReady: () => void }) {
  const pairing = desktop!.pairing!;
  const [setup, setSetup] = useState<RelaySetupState | null>(null);
  const [manual, setManual] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    void pairing.relay.state().then(setSetup).catch(() => {});
    return pairing.relay.onChange(setSetup);
  }, [pairing]);
  // Set up just now: go straight to the pairing QR (it now lists the relay too), as ViewCode does.
  const ready = useRef(onReady);
  ready.current = onReady;
  const prev = useRef<RelaySetupState["status"] | null>(null);
  useEffect(() => {
    const was = prev.current;
    prev.current = setup?.status ?? null;
    if (setup?.status === "done" && was === "running") ready.current();
  }, [setup?.status]);

  const call = (fn: () => Promise<RelaySetupState>) => void fn().then(setSetup).catch((e) => toast(friendlyError(e)));
  const configured = !!st.relay.url && st.relay.hasSecret;
  const state = RELAY_STATE[st.relay.state];
  const hint = <>Your phone reaches this computer from any network through a small relay on your own free Cloudflare account. It only passes along end-to-end encrypted messages — it can't read them.</>;
  const s = setup ?? { status: "idle" as const };

  // Setup in progress, or waiting on the person.
  if (s.status === "running" || s.status === "needs-account" || s.status === "needs-subdomain") {
    return (
      <Group label="Reach from anywhere" hint={hint}>
        <div className="set-row stack relay-setup">
          {s.status === "running" && <SetupSteps current={s.step} message={s.message} />}
          {s.status === "running" && s.step === "signin" && (
            <div className="relay-signin">
              {s.signIn?.code ? (
                <>
                  <div className="d">Approve Sutra in the Cloudflare page that opened. Check it shows this code:</div>
                  <div className="relay-code" aria-label="Sign-in code">{s.signIn.code}</div>
                  {s.signIn.openUrl && <a className="btn sm" href={s.signIn.openUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open Cloudflare again</a>}
                </>
              ) : <div className="d">Starting the Cloudflare sign-in…</div>}
              <div className="set-sub">No Cloudflare account? <a href={CF_SIGNUP} target="_blank" rel="noreferrer">Create one free</a>, then approve the sign-in.</div>
            </div>
          )}
          {s.status === "needs-account" && (
            <>
              <div className="d">{s.message}</div>
              <div className="relay-accounts">
                {s.accounts.map((a) => (
                  <button key={a.id} className="btn sm" onClick={() => call(() => pairing.relay.chooseAccount(a.id))}>{a.name}</button>
                ))}
              </div>
            </>
          )}
          {s.status === "needs-subdomain" && (
            <>
              <div className="d">{s.message}</div>
              <div className="actions">
                <a className="btn sm" href={s.dashboard} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open Cloudflare</a>
                <button className="btn sm primary" onClick={() => call(() => pairing.relay.continueSetup())}>Continue</button>
              </div>
            </>
          )}
          <div className="actions"><button className="btn sm" onClick={() => call(() => pairing.relay.cancel())}>Cancel</button></div>
        </div>
      </Group>
    );
  }

  const done = s.status === "done" || s.status === "unreachable";
  return (
    <Group label="Reach from anywhere" hint={hint}>
      {(s.status === "failed" || done || (s.status === "idle" && s.message)) && (
        <div className={`set-row stack relay-result${s.status === "failed" ? " err" : ""}`}>
          <div className="d">{s.message}</div>
          {(s.status === "failed" || s.status === "unreachable") && s.details && (
            <details className="relay-details"><summary>Details</summary><pre>{s.details}</pre></details>
          )}
          <div className="actions">
            {s.status === "failed" && s.installNode && <a className="btn sm" href="https://nodejs.org/en/download" target="_blank" rel="noreferrer"><ExternalLink size={14} /> Get Node.js</a>}
            {s.status === "failed" && <button className="btn sm primary" onClick={() => call(() => pairing.relay.start())}>Try again</button>}
            <button className="btn sm" onClick={() => call(() => pairing.relay.cancel())}>{s.status === "failed" ? "Dismiss" : "OK"}</button>
          </div>
        </div>
      )}

      {configured ? (
        confirmRemove ? (
          <Row title="Remove your relay?" desc="Paired phones stop reaching this computer. Sutra deletes the relay from your Cloudflare account.">
            <div className="actions">
              <button className="btn sm" onClick={() => setConfirmRemove(false)}>Cancel</button>
              <button className="btn sm danger" onClick={() => { setConfirmRemove(false); call(() => pairing.relay.remove()); }}>Remove</button>
            </div>
          </Row>
        ) : (
          <Row title={<>Your relay {st.relay.enabled ? <Status kind={state.kind}>{state.text}</Status> : <Status>Off</Status>}</>}
            desc={<span className="set-token">{st.relay.url.replace(/^https:\/\//, "")}</span>}>
            <RowMenu label="Relay options" items={[
              st.relay.enabled
                ? { label: "Turn off", onSelect: () => void pairing.setRelay({ enabled: false }).then(onSaved).catch((e) => toast(friendlyError(e))) }
                : { label: "Turn on", onSelect: () => void pairing.setRelay({ enabled: true }).then(onSaved).catch((e) => toast(friendlyError(e))) },
              { label: "Redeploy", onSelect: () => call(() => pairing.relay.start()) },
              { label: "Redeploy with a new secret", onSelect: () => call(() => pairing.relay.start({ rotateSecret: true })) },
              { label: "Remove from this computer only", onSelect: () => call(() => pairing.relay.remove({ localOnly: true })) },
              { label: "Remove", danger: true, onSelect: () => setConfirmRemove(true) },
            ]} />
          </Row>
        )
      ) : (
        <Row title="Connect with Cloudflare" desc={<>Sign in to your free Cloudflare account and Sutra sets up the relay for you — about a minute. <a href={CF_SIGNUP} target="_blank" rel="noreferrer">No account? Create one free.</a></>}>
          <button className="btn sm primary" onClick={() => call(() => pairing.relay.start())}><Cloud size={14} /> Connect</button>
        </Row>
      )}

      {configured && st.relay.state === "auth_failed" && (
        <Row title="The relay didn't accept this computer" desc="Choose Redeploy with a new secret to fix it." />
      )}

      <button className="set-disclosure" aria-expanded={manual} onClick={() => setManual((v) => !v)}>
        {manual ? "Hide" : "Use a relay I set up myself"}
      </button>
      {manual && <ManualRelay st={st} toast={toast} onSaved={onSaved} />}
    </Group>
  );
}

function SetupSteps({ current, message }: { current: SetupStep; message: string }) {
  const at = STEPS.findIndex((x) => x.step === current);
  return (
    <>
      <ol className="relay-steps">
        {STEPS.map((x, i) => (
          <li key={x.step} className={i < at ? "done" : i === at ? "now" : ""}>
            {i < at ? <Check size={13} /> : i === at ? <Loader2 size={13} className="spin" /> : <span className="relay-step-dot" />}
            {x.label}
          </li>
        ))}
      </ol>
      <div className="d relay-msg">{message}</div>
    </>
  );
}

/** A relay deployed by hand (docs/RELAY.md): its address and host secret. */
function ManualRelay({ st, toast, onSaved }: { st: PairingStatus; toast: (m: string) => void; onSaved: (s: PairingStatus) => void }) {
  const pairing = desktop!.pairing!;
  const [url, setUrl] = useState(st.relay.url);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setUrl(st.relay.url), [st.relay.url]);
  const save = async () => {
    setSaving(true);
    try { onSaved(await pairing.setRelay({ url: url.trim(), enabled: true, ...(secret.trim() ? { hostSecret: secret.trim() } : {}) })); setSecret(""); }
    catch (e) { toast(friendlyError(e)); }
    finally { setSaving(false); }
  };
  const dirty = url.trim() !== st.relay.url || secret.trim() !== "";
  return (
    <div className="set-row stack">
      <div className="d">Deployed the relay yourself (<a href={RELAY_DOCS} target="_blank" rel="noreferrer">docs/RELAY.md</a>)? Paste its address and host secret.</div>
      <div className="set-field two">
        <input type="url" value={url} placeholder="https://sutra-relay.you.workers.dev" aria-label="Relay address" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
        <input type="password" value={secret} placeholder={st.relay.hasSecret ? "Host secret (saved)" : "Host secret"} aria-label="Host secret" autoComplete="off" onChange={(e) => setSecret(e.target.value)} />
      </div>
      <div className="actions">
        <button className="btn sm" disabled={saving || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}
