// Phone side of "pair your phone with your Mac", wired into the app: the one connection, the one
// queue of recordings waiting for the Mac, what starts them, and hooks for the UI.
import { useEffect, useState, useSyncExternalStore } from "react";
import { App as CapApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { desktop } from "../desktop/bridge";
import { processSession } from "../local/extraction";
import { ingestWindow } from "../local/ingest";
import { exportMeetingBundle } from "../local/meetingBundle";
import * as repo from "../local/repo";
import { macProvider } from "../providers";
import type { PairOffer } from "../shared/pairing/protocol";
import { macConnection, type MacSnapshot } from "./connection";
import { thisDevice, type Pairing } from "./model";
import { capacitorQueueFs, Outbox, type QueueStats } from "./outbox";
import { forgetPairing, getPairing, pairWithOffer } from "./state";

/** The Mac can take audio: connected, and its speech engine is ready. */
function macReady(): boolean {
  const c = macConnection();
  return c.isOnline && c.snapshot().hostInfo?.speech.ready === true;
}

let box: Outbox | null = null;
export function outbox(): Outbox {
  return (box ??= new Outbox({
    fs: capacitorQueueFs,
    storageKey: async () => (await getPairing())?.storageKey ?? null,
    ready: macReady,
    ingest: async (sid, blob, index, filename, startMs) => ingestWindow(sid, blob, index, macProvider(await repo.getSettings()), filename, startMs),
    process: async (sid) => processSession(sid, macProvider(await repo.getSettings())),
    conversations: async (sid) => {
      const [all, noNotes] = await Promise.all([repo.sessionConversationIds(sid), repo.sessionConversationsWithoutMemory(sid)]);
      return all.map((id) => ({ id, finished: !noNotes.includes(id) }));
    },
    sync: async (cid) => {
      const bundle = await exportMeetingBundle(cid, thisDevice());
      await (await macConnection().whenOnline()).request("meetings.put", { bundle }, 60_000);
    },
  }));
}

let started = false;
/** Start once per app launch (phone/web only): connect to the paired Mac, redial on resume and when the
 *  network returns, recover recordings cut short by the app being killed, and send what's waiting. */
export function startPairingRuntime(): void {
  if (desktop || started) return;
  started = true;
  const conn = macConnection();
  let wasReady = false;
  conn.subscribe(() => {
    const ready = macReady();
    if (ready && !wasReady) void outbox().drain();
    wasReady = ready;
  });
  window.addEventListener("online", () => conn.kick());
  if (Capacitor.isNativePlatform()) {
    void CapApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) return;
      conn.kick();
      void outbox().drain();
    });
  }
  void (async () => {
    await conn.start();
    if (!(await getPairing())) return;
    for (const sid of await outbox().recover()) await repo.closeSession(sid).catch(() => {});
    void outbox().drain();
  })().catch((e) => console.warn("[pairing] start failed", String((e as Error)?.message ?? e)));
}

/** Pair with the Mac whose code was scanned or pasted, and start using it. */
export async function pair(offer: PairOffer): Promise<Pairing> {
  const { pairing, link, route } = await pairWithOffer(offer);
  macConnection().adopt(pairing, link, route.kind);
  return pairing;
}

/** Forget the Mac, and delete every recording still waiting for it. */
export async function unpair(): Promise<void> {
  await forgetPairing();
  await macConnection().reload();
  await outbox().clear();
}

// ---- hooks ----

export function useMac(): MacSnapshot {
  const conn = macConnection();
  return useSyncExternalStore((cb) => conn.subscribe(cb), () => conn.snapshot());
}

/** What's waiting on the phone for the Mac (null until read, or when `enabled` is false). */
export function useQueueStats(enabled = true): QueueStats | null {
  const [stats, setStats] = useState<QueueStats | null>(null);
  useEffect(() => {
    if (!enabled) { setStats(null); return; }
    let alive = true;
    const load = () => { void outbox().stats().then((s) => { if (alive) setStats(s); }).catch(() => {}); };
    load();
    const off = outbox().subscribe((e) => { if (e.t === "changed") load(); });
    return () => { alive = false; off(); };
  }, [enabled]);
  return stats;
}
