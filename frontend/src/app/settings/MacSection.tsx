// Settings → Your Mac (phone only): pair with Sutra on a Mac so it transcribes and writes the notes,
// see whether it's reachable, what's waiting on the phone for it, and unpair.
import { useState } from "react";
import { ClipboardPaste, QrCode, RotateCw, Trash2 } from "lucide-react";
import { AGENTS } from "../../shared/agentProtocol";
import { decodePairLink } from "../../shared/pairing/protocol";
import { macConnection, type MacStatus } from "../../pairing/connection";
import { PAIRED_ENGINE_KEY, PAIRED_MODEL_KEY, pairedAiChoice } from "../../pairing/model";
import { outbox, pair, unpair, useMac, useQueueStats } from "../../pairing/runtime";
import type { QueueStats } from "../../pairing/outbox";
import { ENGINE_EVENT } from "../EnginePicker";
import { prettyModel } from "../modelPicker";
import { friendlyError } from "../ui";
import { Group, Row, Status, type SectionProps } from "./kit";
import { QrScanner } from "./QrScanner";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function statusLine(s: MacStatus, q: QueueStats | null): { kind?: "ok" | "err"; text: string } {
  const waiting = q?.recordings ? ` — ${plural(q.recordings, "recording")} waiting` : "";
  switch (s.state) {
    case "online": return { kind: "ok", text: s.route === "lan" ? "Connected over Wi-Fi" : "Connected through your relay" };
    case "connecting": return { text: `Connecting…${waiting}` };
    case "revoked": return { kind: "err", text: "Removed by your Mac" };
    default: return { text: `Mac not reachable${waiting}` };
  }
}

export function MacSection({ settings, put, toast }: SectionProps) {
  const mac = useMac();
  const paired = !!mac.pairing;
  const stats = useQueueStats(paired);
  const [scanning, setScanning] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const connect = async (text: string) => {
    setScanning(false);
    setError(null);
    setBusy(true);
    try {
      const p = await pair(decodePairLink(text));
      setJustPaired(p.hostName);
      setPasting(false);
      setLink("");
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const doUnpair = async () => {
    setConfirmUnpair(false);
    try { await unpair(); setJustPaired(null); toast("Unpaired"); } catch (e) { toast(friendlyError(e)); }
  };

  const followMac = async () => {
    await put({ [PAIRED_ENGINE_KEY]: null, [PAIRED_MODEL_KEY]: null });
    window.dispatchEvent(new Event(ENGINE_EVENT));
  };

  const sendNow = () => {
    macConnection().kick();
    void (stats?.failed ? outbox().retryFailed() : outbox().drain());
  };

  const scanner = scanning && <QrScanner onCode={(t) => void connect(t)} onClose={() => setScanning(false)} />;
  const pairButtons = (
    <div className="actions">
      <button className="btn sm" onClick={() => setPasting((v) => !v)} disabled={busy}><ClipboardPaste size={14} /> Paste link</button>
      <button className="btn sm primary" onClick={() => { setError(null); setScanning(true); }} disabled={busy}><QrCode size={14} /> {busy ? "Pairing…" : "Scan pairing code"}</button>
    </div>
  );
  const pasteRow = pasting && (
    <div className="set-row stack">
      <form className="mac-paste" onSubmit={(e) => { e.preventDefault(); if (link.trim()) void connect(link); }}>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="sutra-pair:1:…" aria-label="Pairing link" autoFocus spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        <button className="btn sm" disabled={busy || !link.trim()}>Pair</button>
      </form>
    </div>
  );
  const errorRow = error && <div className="set-row"><div className="grow"><div className="d mac-error">{error}</div></div></div>;

  if (!mac.pairing) {
    return (
      <>
        <Group label="Your Mac" hint="On your Mac, open Sutra → Settings → Phones to show the pairing code.">
          <Row title="Let your Mac do the work"
            desc="Pair this phone with Sutra on your Mac. Your Mac transcribes your recordings and writes the notes with the AI you use there, and every meeting shows up on both. Nothing goes to the Sutra cloud." />
          <Row title="Pair with your Mac" className="stack">{pairButtons}</Row>
          {pasteRow}
          {errorRow}
        </Group>
        {scanner}
      </>
    );
  }

  const p = mac.pairing;
  const info = mac.hostInfo;
  const line = statusLine(mac.status, stats);
  const own = pairedAiChoice(settings);
  const engineId = own.engine ?? info?.activeEngine ?? null;
  const engineModel = own.engine ? own.model : info?.activeModel ?? null;
  const engineText = engineId
    ? `${AGENTS[engineId].label}${engineModel ? ` · ${prettyModel(engineModel)}` : ""}${own.engine ? "" : " (your Mac's choice)"}`
    : "Your Mac's choice";
  const speech = info?.speech;

  return (
    <>
      <Group label="Your Mac" hint={justPaired ? `Paired with ${justPaired}. Recordings from this phone are now transcribed on your Mac.`
        : mac.status.state === "offline" ? mac.status.error ?? undefined : undefined}>
        <Row title={p.hostName} desc={<Status kind={line.kind}>{line.text}</Status>} />
        {mac.status.state === "revoked" ? (
          <>
            <Row title="Pair again" className="stack"
              desc={`Your Mac no longer recognises this phone.${stats?.recordings ? ` ${plural(stats.recordings, "recording")} still waiting here will be sent once you pair again.` : ""}`}>
              {pairButtons}
            </Row>
            {pasteRow}
            {errorRow}
          </>
        ) : info && (
          <>
            <Row title="AI" desc={engineText}>
              {own.engine && <button className="btn sm" onClick={() => void followMac()}>Use Mac's choice</button>}
            </Row>
            <Row title="Transcription"
              desc={speech?.ready ? `Ready on your Mac${speech.model ? ` · ${speech.model}` : ""}` : speech?.error ?? "Not set up on your Mac yet — choose a model in Settings → Transcription there."} />
          </>
        )}
      </Group>

      {!!stats && (stats.windows > 0 || stats.recordings > 0 || stats.failed > 0) && (
        <Group label="Waiting on this phone" hint="Kept encrypted on this phone only until your Mac transcribes it, then deleted.">
          {(stats.windows > 0 || stats.recordings > 0) && (
            <Row title={plural(stats.recordings || 1, "recording")} desc={mac.status.state === "online" ? "Sending to your Mac…" : "It'll be sent when your Mac is reachable."}>
              {mac.status.state !== "revoked" && <button className="btn sm" onClick={sendNow}><RotateCw size={14} /> Send now</button>}
            </Row>
          )}
          {stats.failed > 0 && (
            <Row title={`${plural(stats.failed, "part")} couldn't be transcribed`} desc="Your Mac couldn't read this audio after several tries.">
              <div className="actions">
                <button className="btn sm" onClick={() => void outbox().discardFailed()}><Trash2 size={14} /> Delete</button>
                <button className="btn sm" onClick={() => void outbox().retryFailed()}><RotateCw size={14} /> Retry</button>
              </div>
            </Row>
          )}
        </Group>
      )}

      <Group>
        {!confirmUnpair ? (
          <Row title="Unpair" desc="This phone goes back to working on its own. Your meetings stay on both devices.">
            <button className="btn sm danger" onClick={() => setConfirmUnpair(true)}>Unpair</button>
          </Row>
        ) : (
          <Row title={`Unpair from ${p.hostName}?`}
            desc={stats?.windows || stats?.failed ? `${plural((stats.windows ?? 0) + (stats.failed ?? 0), "audio part")} waiting on this phone will be deleted — they haven't been transcribed yet.` : "Pair again any time from this screen."}>
            <div className="actions">
              <button className="btn sm" onClick={() => setConfirmUnpair(false)}>Cancel</button>
              <button className="btn sm danger" onClick={() => void doUnpair()}>Unpair</button>
            </div>
          </Row>
        )}
      </Group>
      {scanner}
    </>
  );
}
