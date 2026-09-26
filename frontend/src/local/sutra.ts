// Local-first facade consumed by the app pages. Everything runs on-device (SQLite) except provider
// calls (cloud by default = hybrid mode).
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { getProvider, MODE_COPY, type Mode } from "../providers";
import { q } from "./db";
import * as chatSvc from "./chat";
import * as extractSvc from "./extraction";
import { expand, graphOverview } from "./graph";
import * as ingestSvc from "./ingest";
import * as peopleSvc from "./people";
import * as notesSvc from "./notes";
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

  createSession: (device?: string, kind?: repo.SessionKind, sourceApp?: string | null) => repo.createSession(device, kind, sourceApp),
  listSessions: () => repo.listSessions(),
  closeSession: async (sid: number) => { await repo.closeSession(sid); return { session_id: sid, status: "closed" }; },
  processSession: async (sid: number) => extractSvc.processSession(sid, await provider()),
  /** Recover any recording that was transcribed but never fully processed (app killed / proxy down /
   *  prior crash). Safe to call on launch. Hybrid only — no-ops cleanly on-device. */
  reprocessIncomplete: async () => extractSvc.reprocessIncomplete(await provider()),
  sessionTurns: (sid: number) => repo.sessionTurns(sid),
  ingestWindow: async (sid: number, blob: Blob, index: number, filename?: string, windowStartMs?: number, channelOpts?: boolean | ingestSvc.IngestChannelOpts) =>
    ingestSvc.ingestWindow(sid, blob, index, await provider(), filename, windowStartMs, channelOpts),
  /** The conversation a finished recording produced (the newest one in its session). */
  conversationForSession: (sid: number) => repo.latestConversationForSession(sid),

  listPeople: () => repo.listPeople(),
  enroll: (fd: FormData) => peopleSvc.enroll(String(fd.get("name") ?? ""), String(fd.get("is_me")) === "true", fd.get("file") as Blob | null),
  relabel: (sid: number, label: string, body: any) => peopleSvc.relabelSpeaker(sid, label, body),
  deletePerson: async (pid: number) => { await repo.deletePerson(pid); return { deleted: pid }; },

  listConversations: () => repo.listConversations(),
  conversation: (cid: number) => repo.conversationDetail(cid),
  deleteConversation: (cid: number) => repo.deleteConversation(cid),
  setTags: (cid: number, tags: string[]) => repo.setConversationTags(cid, tags),
  setTitle: (cid: number, title: string) => repo.setConversationTitle(cid, title),
  /** Re-run extraction for one meeting (e.g. after renaming speakers, or after a failure). */
  reprocessConversation: async (cid: number) => extractSvc.extractConversation(cid, await provider()),

  // Meeting notes (Brief comes with the extraction; Detailed is generated on demand and cached).
  detailedNotes: async (cid: number, force = false) => notesSvc.detailedNotes(cid, await provider(), force),
  askMeeting: async (cid: number, question: string, history: { q: string; a: string }[] = []) =>
    notesSvc.askMeeting(cid, question, await provider(), history),
  notesMarkdown: async (cid: number, style: notesSvc.NoteStyle, withTranscript = false) => {
    const d = await repo.conversationDetail(cid);
    if (!d) return "";
    const detailed = style === "detailed" ? ((await repo.getNotes(cid, "detailed")) as any) : null;
    return notesSvc.notesToMarkdown(d, style, detailed, withTranscript);
  },
  /** Copy text to the clipboard, falling back to execCommand for old / insecure WebViews. */
  copyText: async (text: string) => {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  },
  /** Save/share a text file: native share sheet on mobile, a download (save dialog) elsewhere. */
  exportText: async (filename: string, text: string, mime = "text/markdown") => {
    if (Capacitor.isNativePlatform()) {
      const path = `exports/${filename}`;
      const written = await Filesystem.writeFile({ path, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
      const uri = written.uri || (await Filesystem.getUri({ path, directory: Directory.Cache })).uri;
      try { await Share.share({ title: filename, files: [uri], dialogTitle: "Export" }); }
      catch (e: any) { if (!/cancel/i.test(String(e?.message ?? e))) throw e; }
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
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

  // Your Context (priors) — local-only CRUD; no provider needed. The context_enabled master toggle
  // rides the existing putSettings({ context_enabled }) path, not a dedicated facade method.
  listPriors: () => repo.listPriors(),
  addPrior: (p: any) => repo.insertPrior(p),
  confirmPrior: (id: number) => repo.setPriorStatus(id, "confirmed"),
  dismissPrior: (id: number) => repo.setPriorStatus(id, "dismissed"),
  editPrior: (id: number, patch: any) => repo.editPrior(id, patch),
  supersedePrior: (oldId: number, newPrior: any) => repo.supersedePrior(oldId, newPrior),
  setPriorShareCloud: (id: number, on: boolean) => repo.setPriorShareCloud(id, on),

  // Projects — user-authored, per-project context (on-device only in v1). Local CRUD; no provider needed.
  createProject: (name?: string) => repo.createProject(name),
  updateProject: (id: number, patch: Parameters<typeof repo.updateProject>[1]) => repo.updateProject(id, patch),
  deleteProject: (id: number) => repo.deleteProject(id),
  listProjects: () => repo.listProjects(),
  getProject: (id: number) => repo.getProject(id),
  addProjectPerson: (projectId: number, member: Parameters<typeof repo.addProjectPerson>[1]) => repo.addProjectPerson(projectId, member),
  setProjectPersonRole: (projectId: number, personId: number, role: string | null) => repo.setProjectPersonRole(projectId, personId, role),
  removeProjectPerson: (projectId: number, personId: number) => repo.removeProjectPerson(projectId, personId),
  // Mapping a conversation is always a USER choice (auto=false), which also clears any pending suggestion.
  setConversationProject: (convId: number, projectId: number | null) => repo.setConversationProject(convId, projectId),
  projectForConversation: (convId: number) => repo.projectForConversation(convId),
  // P3 mapping/provenance: confirm a MEDIUM suggestion (one tap -> a real user map), or dismiss it.
  confirmProjectSuggestion: (convId: number, projectId: number) => repo.setConversationProject(convId, projectId),
  dismissProjectSuggestion: (convId: number) => repo.setConversationProjectSuggestion(convId, null),

  getMode: currentMode,
  setMode: (m: Mode) => repo.putSettings({ mode: m }),
  training: {
    stats: () => training.stats(),
    setTextOptIn: (on: boolean) => training.setTextOptIn(on),
    setAudioOptIn: (on: boolean) => training.setAudioOptIn(on),
    wipe: () => training.wipe(),
    export: async (kind: "extraction" | "asr") => {
      const jsonl = await training.exportJSONL(kind);
      const lines = jsonl ? jsonl.split("\n").length : 0;
      const filename = `sutra-training-${kind}.jsonl`;
      if (Capacitor.isNativePlatform()) {
        const path = `exports/${filename}`;
        const written = await Filesystem.writeFile({
          path,
          data: jsonl,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        const uri = written.uri || (await Filesystem.getUri({ path, directory: Directory.Cache })).uri;
        try {
          await Share.share({
            title: "Sutra training export",
            files: [uri],
            dialogTitle: "Export Sutra training data",
          });
        } catch (e: any) {
          if (!/cancel/i.test(String(e?.message ?? e))) throw e;
        }
        return { lines, uri };
      }
      // Web: download a file.
      try {
        const blob = new Blob([jsonl], { type: "application/x-ndjson" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = filename; a.click();
        URL.revokeObjectURL(a.href);
      } catch { /* non-browser */ }
      return { lines };
    },
  },
};

// Debug hook: expose the local API on window so on-device issues can be inspected/repaired live via
// the WebView DevTools (CDP). Dev-only — never exposed in production builds (the API includes a
// destructive `wipe`), so gate it strictly behind import.meta.env.DEV.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as any).__sutra = api;
}
