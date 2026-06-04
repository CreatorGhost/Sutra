// Local-first facade: same surface as the old lib/api.ts so pages swap with a one-line import change.
// Everything runs on-device (SQLite) except provider calls (cloud by default = hybrid mode).
import { getProvider, MODE_COPY, type Mode } from "../providers";
import { q } from "./db";
import * as chatSvc from "./chat";
import * as extractSvc from "./extraction";
import { expand, graphOverview } from "./graph";
import * as ingestSvc from "./ingest";
import * as peopleSvc from "./people";
import * as recapSvc from "./recap";
import * as repo from "./repo";
import { searchMemories } from "./search";
import * as training from "./training";

async function currentMode(): Promise<Mode> {
  return (String((await repo.getSettings())["mode"] ?? "hybrid") as Mode);
}
async function provider() { return getProvider(await currentMode()); }

export const api = {
  health: async () => ({ status: "ok", mode: await currentMode(), privacy: MODE_COPY[await currentMode()].audio }),
  modeCopy: () => MODE_COPY,
  getSettings: () => repo.getSettings(),
  putSettings: (data: Record<string, unknown>) => repo.putSettings(data),

  createSession: (device?: string) => repo.createSession(device),
  listSessions: () => repo.listSessions(),
  closeSession: async (sid: number) => { await repo.closeSession(sid); return { session_id: sid, status: "closed" }; },
  processSession: async (sid: number) => extractSvc.processSession(sid, await provider()),
  /** Recover any recording that was transcribed but never fully processed (app killed / proxy down /
   *  prior crash). Safe to call on launch. Hybrid only — no-ops cleanly on-device. */
  reprocessIncomplete: async () => extractSvc.reprocessIncomplete(await provider()),
  sessionTurns: (sid: number) => repo.sessionTurns(sid),
  ingestWindow: async (sid: number, blob: Blob, index: number, filename?: string) =>
    ingestSvc.ingestWindow(sid, blob, index, await provider(), filename),

  listPeople: () => repo.listPeople(),
  enroll: (fd: FormData) => peopleSvc.enroll(String(fd.get("name") ?? ""), String(fd.get("is_me")) === "true", fd.get("file") as Blob | null),
  relabel: (sid: number, label: string, body: any) => peopleSvc.relabelSpeaker(sid, label, body),
  deletePerson: async (pid: number) => { await repo.deletePerson(pid); return { deleted: pid }; },

  listConversations: () => repo.listConversations(),
  conversation: (cid: number) => repo.conversationDetail(cid),
  upcomingEvents: () => repo.upcomingEvents(new Date().toISOString()),
  graph: (entityId?: number, hops = 2) => (entityId ? expand([entityId], hops) : graphOverview()),
  entities: () => q("SELECT id,type,canonical_name,importance,mention_count,first_seen,last_seen FROM entities ORDER BY mention_count DESC, importance DESC LIMIT 300"),

  search: async (qstr: string, topN?: number) => ({ query: qstr, results: await searchMemories(qstr, await provider(), topN) }),
  chat: async (message: string, history: any[] = []) => chatSvc.chat(message, await provider(), history),

  actionItems: (status?: string) => repo.listActions(status),
  updateAction: async (id: number, status: string) => { await repo.setActionStatus(id, status); return { id, status }; },
  draftAction: async (id: number) => {
    const a = (await q("SELECT * FROM action_items WHERE id=?", [id]))[0] as any;
    if (!a) throw new Error("action item not found");
    const schema = { name: "draft", strict: true, schema: { type: "object", properties: { draft: { type: "string" } }, required: ["draft"], additionalProperties: false } };
    const out = await (await provider()).chat(schema, "Write a short, polite email draft to accomplish this action item. Output only the email body.", `Action item: ${a.text}\nOwner: ${a.owner}\nDue: ${a.due}`);
    await q("UPDATE action_items SET generated_draft=? WHERE id=?", [out.draft ?? "", id]);
    return { id, draft: out.draft ?? "" };
  },

  runRecap: async (day?: string) => {
    const d = day || new Date().toISOString().slice(0, 10);
    const rollup = await recapSvc.buildRollup(d, await provider());
    return { emailed: false, rollup }; // delivery is a local notification; email is opt-in only
  },
  rollups: () => repo.listRollups(),

  getMode: currentMode,
  setMode: (m: Mode) => repo.putSettings({ mode: m }),
  training: {
    stats: () => training.stats(),
    setTextOptIn: (on: boolean) => training.setTextOptIn(on),
    setAudioOptIn: (on: boolean) => training.setAudioOptIn(on),
    wipe: () => training.wipe(),
    export: async (kind: "extraction" | "asr") => {
      const jsonl = await training.exportJSONL(kind);
      // Web: download a file. (On device, a Phase-next step writes via Filesystem/Share to user-chosen storage.)
      try {
        const blob = new Blob([jsonl], { type: "application/x-ndjson" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = `sutra-training-${kind}.jsonl`; a.click();
        URL.revokeObjectURL(a.href);
      } catch { /* non-browser */ }
      return { lines: jsonl ? jsonl.split("\n").length : 0 };
    },
  },
};

// Debug hook: expose the local API on window so on-device issues can be inspected/repaired live via
// the WebView DevTools (CDP). Harmless locally; gate/remove for a public production build.
if (typeof window !== "undefined") (window as any).__sutra = api;
