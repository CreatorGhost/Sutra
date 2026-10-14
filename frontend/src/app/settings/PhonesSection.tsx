import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, QrCode, RefreshCw, Smartphone } from "lucide-react";
import { desktop, isMacDesktop, type PairingStatus } from "../../desktop/bridge";
import { friendlyError } from "../ui";
import { Group, Row, RowMenu, Status, SwitchRow, type SectionProps } from "./kit";

// Phones (desktop only): pair the Sutra phone app with this computer. A paired phone records, then this
// computer transcribes each window with its own speech model, writes every note with its own AI engine,
// and keeps a copy of the finished meeting. Phones reach it on the same Wi-Fi directly, or from
// anywhere through the user's own Cloudflare relay — end-to-end encrypted either way
// (electron/pairing/*, src/shared/pairing/*).

const RELAY_DOCS = "https://github.com/CreatorGhost/Sutra/blob/main/docs/RELAY.md";

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
          <Row title="Pair a phone" desc="Record on your phone. This computer transcribes and writes the notes with its own engine, and keeps a copy of every meeting.">
            <button className="btn sm primary" onClick={newCode} disabled={busy}><QrCode size={14} /> Pair a phone</button>
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

      <RelayCard st={st} toast={toast} onSaved={setSt} />

      <Group hint={<>{isMacDesktop ? "macOS may ask to allow incoming connections — allow it so your phone can reach Sutra." : "Your firewall may ask to allow incoming connections — allow it so your phone can reach Sutra."}{st.lan.error ? <> {st.lan.error}</> : null}</>}>
        <SwitchRow title="Allow phones on this Wi-Fi" desc="Phones on the same network connect to this computer directly."
          checked={st.lan.enabled} onChange={(on) => void act(async () => setSt(await pairing.setLan(on)))} />
      </Group>
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
            <li key={r.url}>{r.kind === "lan" ? <>Same Wi-Fi: <span className="set-token">{new URL(r.url).hostname}</span></> : "Anywhere: via your relay"}</li>
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

/** "Reach from anywhere": the user's own relay (address + host secret) and its live state. */
function RelayCard({ st, toast, onSaved }: { st: PairingStatus; toast: (m: string) => void; onSaved: (s: PairingStatus) => void }) {
  const pairing = desktop!.pairing!;
  const [url, setUrl] = useState(st.relay.url);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setUrl(st.relay.url), [st.relay.url]);

  const save = async (patch: { url?: string; hostSecret?: string; enabled?: boolean }) => {
    setSaving(true);
    try { onSaved(await pairing.setRelay(patch)); setSecret(""); }
    catch (e) { toast(friendlyError(e)); }
    finally { setSaving(false); }
  };
  const dirty = url.trim() !== st.relay.url || secret.trim() !== "";
  const state = RELAY_STATE[st.relay.state];

  return (
    <Group label="Reach from anywhere" hint={<>Deploy your own relay to your Cloudflare account in 2 minutes — <a href={RELAY_DOCS} target="_blank" rel="noreferrer">see docs/RELAY.md</a>. It only passes encrypted messages along; it can't read them.</>}>
      <SwitchRow title="Use my relay" desc="When your phone isn't on the same Wi-Fi, it reaches this computer through your relay."
        checked={st.relay.enabled} onChange={(on) => void save({ enabled: on })} />
      {st.relay.enabled && (
        <>
          <div className="set-row stack">
            <div className="set-field two">
              <input type="url" value={url} placeholder="https://sutra-relay.you.workers.dev" aria-label="Relay address" spellCheck={false}
                onChange={(e) => setUrl(e.target.value)} />
              <input type="password" value={secret} placeholder={st.relay.hasSecret ? "Host secret (saved)" : "Host secret"} aria-label="Host secret" autoComplete="off"
                onChange={(e) => setSecret(e.target.value)} />
            </div>
            <div className="actions">
              <button className="btn sm" disabled={saving || !dirty} onClick={() => void save({ url: url.trim(), ...(secret.trim() ? { hostSecret: secret.trim() } : {}) })}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
          <Row title="Status" desc={st.relay.state === "auth_failed" ? "The relay didn't accept the host secret. Paste it again and save." : !st.relay.url || !st.relay.hasSecret ? "Add your relay's address and host secret." : undefined}>
            <Status kind={state.kind}>{state.text}</Status>
          </Row>
        </>
      )}
    </Group>
  );
}
