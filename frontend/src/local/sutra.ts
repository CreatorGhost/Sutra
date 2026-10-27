// Local-first facade consumed by the app pages. Everything runs on-device (SQLite) except provider
// calls (cloud by default = hybrid mode).
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { MODE_COPY, resolveProvider, type Mode } from "../providers";
import { persist, q, run } from "./db";
import * as chatSvc from "./chat";
import * as extractSvc from "./extraction";
import { expand, graphOverview } from "./graph";
import * as ingestSvc from "./ingest";
import * as peopleSvc from "./people";
import * as minutesSvc from "./minutes";
import * as notesSvc from "./notes";
import * as refinementSvc from "./refinement";
import * as recapSvc from "./recap";
import * as foldersSvc from "./projectFolders";
import * as visualSvc from "./visual";
import { desktop } from "../desktop/bridge";
import * as repo from "./repo";
import { searchMemories } from "./search";
import * as training from "./training";

async function currentMode(): Promise<Mode> {
  return (String((await repo.getSettings())["mode"] ?? "hybrid") as Mode);
}
async function provider() { return resolveProvider(await repo.getSettings()); }

/** Window event after settings are saved; `detail` = the keys that changed. */
export const SETTINGS_CHANGED_EVENT = "sutra:settings";

export const api = {
  health: async () => ({ status: "ok", mode: await currentMode(), privacy: MODE_COPY[await currentMode()].audio }),
  modeCopy: () => MODE_COPY,
  getSettings: () => repo.getSettings(),
  putSettings: async (data: Record<string, unknown>) => {
    const next = await repo.putSettings(data);
    try { window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: Object.keys(data) })); } catch { /* non-DOM */ }
    return next;
  },

  createSession: (device?: string, kind?: repo.SessionKind, sourceApp?: string | null) => repo.createSession(device, kind, sourceApp),
  listSessions: () => repo.listSessions(),
  closeSession: async (sid: number) => { await repo.closeSession(sid); return { session_id: sid, status: "closed" }; },
  processSession: async (sid: number, projectId?: number | null) => extractSvc.processSession(sid, await provider(), projectId),
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
  deleteConversation: async (cid: number) => {
    // Its recording (screenshots + audio) and kept screenshots go with it.
    const sid = await repo.sessionForConversation(cid).catch(() => null);
    if (desktop?.media) {
      if (sid != null) await desktop.media.deleteSession(sid).catch(() => {});
      await desktop.media.deleteKept(cid).catch(() => {});
    }
    await repo.deleteConversation(cid);
  },
  // Notes that saw the screen: what was looked at, the kept screenshots, the recording awaiting confirmation.
  meetingVisual: async (cid: number) => {
    const sid = await repo.sessionForConversation(cid);
    const [visual, images, recording] = await Promise.all([
      repo.getMeetingVisual(cid), repo.listMeetingImages(cid),
      sid != null && desktop?.media ? desktop.media.status(sid).catch(() => null) : Promise.resolve(null),
    ]);
    return { session: sid, visual, images, recording };
  },
  keptImage: async (cid: number, name: string) => {
    const bytes = await desktop!.media!.readKept(cid, name);
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
  },
  recordingAudio: async (sid: number) => {
    const a = await desktop!.media!.readAudio(sid);
    return a ? URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime ?? "audio/webm" })) : null;
  },
  removeMeetingImage: async (cid: number, img: { id: number; name: string }) => {
    await repo.deleteMeetingImage(img.id);
    await desktop?.media?.deleteKept(cid, img.name).catch(() => {});
  },
  confirmRecording: (cid: number) => visualSvc.confirmRecording(cid),
  /** The screenshots were of the wrong screen (or just noise): drop what the AI took from them and
   *  rewrite the notes from the transcript alone. The recording stays until it's confirmed. */
  notesWithoutScreen: async (cid: number) => {
    const sid = await repo.sessionForConversation(cid);
    if (sid == null) throw new Error("This meeting has no recording.");
    await repo.setMeetingVisual(cid, { session_id: sid, error: "Screenshots left out." });
    await repo.clearMeetingImages(cid);
    await desktop?.media?.deleteKept(cid).catch(() => {});
    await extractSvc.extractConversation(cid, await provider(), []);
  },
  /** Look at the recording's screenshots again (e.g. after switching to an engine that can see), then
   *  rewrite the notes with what was on screen. */
  relookAtScreen: async (cid: number) => {
    const sid = await repo.sessionForConversation(cid);
    if (sid == null) throw new Error("This meeting has no recording.");
    const p = await provider();
    const facts = await visualSvc.visualPass(cid, sid, p);
    await extractSvc.extractConversation(cid, p, facts);
  },
  setTags: (cid: number, tags: string[]) => repo.setConversationTags(cid, tags),
  setTitle: (cid: number, title: string) => repo.setConversationTitle(cid, title),
  /** Re-run extraction for one meeting (e.g. after renaming speakers, or after a failure). */
  cleanConversation: async (cid: number) => refinementSvc.cleanConversation(cid, await provider()),
  setConversationRefined: async (cid: number, on: boolean) => refinementSvc.setRefined(cid, on, await provider()),
  // Minutes of Meeting — generate/regenerate (cloud), clear, or share/copy as Markdown.
  generateMinutes: async (cid: number) => minutesSvc.generateMinutes(cid, await provider()),
  clearMinutes: (cid: number) => minutesSvc.clearMinutes(cid),
  shareMinutes: async (cid: number) => {
    const d = await repo.conversationDetail(cid);
    const text = minutesSvc.minutesToMarkdown((d?.conversation as any)?.title, d?.minutes as any);
    if (!text) return { ok: false };
    if (Capacitor.isNativePlatform()) {
      try { await Share.share({ title: "Meeting minutes", text, dialogTitle: "Share minutes" }); }
      catch (e: any) { if (!/cancel/i.test(String(e?.message ?? e))) throw e; }
    } else {
      try { await navigator.clipboard.writeText(text); } catch { /* clipboard may be blocked */ }
    }
    return { ok: true };
  },
  // Explicit one-tap copy of the same Markdown the Share action builds. Works on the Android WebView:
  // tries the async clipboard API first, then falls back to a hidden-textarea execCommand("copy") for
  // old/insecure WebViews. Returns ok:false when there are no minutes or every copy path failed.
  copyMinutes: async (cid: number) => {
    const d = await repo.conversationDetail(cid);
    const text = minutesSvc.minutesToMarkdown((d?.conversation as any)?.title, d?.minutes as any);
    if (!text) return { ok: false };
    try { await navigator.clipboard.writeText(text); return { ok: true }; }
    catch { /* clipboard API unavailable (insecure context / old WebView) — fall back below */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); document.body.removeChild(ta);
      return { ok };
    } catch { return { ok: false }; }
  },
  reprocessConversation: async (cid: number) => extractSvc.extractConversation(cid, await provider()),

  // Meeting notes (Brief comes with the extraction; Detailed is generated on demand and cached).
  detailedNotes: async (cid: number, force = false) => notesSvc.detailedNotes(cid, await provider(), force),
  askMeeting: async (cid: number, question: string, history: { q: string; a: string }[] = []) =>
    notesSvc.askMeeting(cid, question, await provider(), history),
  // A meeting's chat, saved with it; answers can be added to the meeting's notes.
  meetingChat: (cid: number) => repo.listMeetingChat(cid),
  chatMeeting: async (cid: number, question: string) => notesSvc.chatMeeting(cid, question, await provider()),
  setChatPinned: (id: number, pinned: boolean) => repo.setMeetingChatPinned(id, pinned),
  updateChatMessage: (id: number, content: string) => repo.updateMeetingChat(id, content),
  deleteChatMessage: (id: number) => repo.deleteMeetingChat(id),
  clearMeetingChat: (cid: number) => repo.clearMeetingChat(cid),
  addMeetingNote: (cid: number, content: string) => repo.addMeetingChat(cid, { role: "note", content, pinned: true }),
  notesMarkdown: async (cid: number, style: notesSvc.NoteStyle, withTranscript = false) => {
    const d = await repo.conversationDetail(cid);
    if (!d) return "";
    const detailed = style === "detailed" ? ((await repo.getNotes(cid, "detailed")) as any) : null;
    return notesSvc.notesToMarkdown(d, style, detailed, withTranscript, await repo.meetingAdditions(cid));
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
  chat: async (message: string, history: any[] = [], projectId: number | null = null, opts?: Parameters<typeof chatSvc.chat>[4]) =>
    chatSvc.chat(message, await provider(), history, projectId, opts),

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
  mergePlaceholderOwner: () => repo.mergePlaceholderOwner(),
  updateProject: (id: number, patch: Parameters<typeof repo.updateProject>[1]) => repo.updateProject(id, patch),
  deleteProject: (id: number) => repo.deleteProject(id),
  listProjects: () => repo.listProjects(),
  getProject: (id: number) => repo.getProject(id),
  addProjectPerson: (projectId: number, member: Parameters<typeof repo.addProjectPerson>[1]) => repo.addProjectPerson(projectId, member),
  setProjectPersonRole: (projectId: number, personId: number, role: string | null) => repo.setProjectPersonRole(projectId, personId, role),
  removeProjectPerson: (projectId: number, personId: number) => repo.removeProjectPerson(projectId, personId),
  // Code folders (desktop): Ask may read them, read-only; the brief/people/glossary can be suggested from them.
  linkProjectFolder: (projectId: number) => foldersSvc.linkFolder(projectId),
  unlinkProjectFolder: (projectId: number, path: string) => foldersSvc.unlinkFolder(projectId, path),
  scanProjectFolders: (paths: string[]) => foldersSvc.scanFolders(paths),
  suggestFromFolders: async (projectId: number) => foldersSvc.suggestFromFolders(projectId, await provider()),
  draftAgentsFile: async (projectId: number, folder: string) => foldersSvc.draftAgentsFile(projectId, folder, await provider()),
  saveAgentsFile: (folder: string, content: string) => foldersSvc.saveAgentsFile(folder, content),
  // Mapping a conversation is always a USER choice: routes through the people service so it overrides any
  // silent auto-map, clears the pending suggestion, and re-runs that conversation's minutes (best-effort).
  setConversationProject: (convId: number, projectId: number | null) => peopleSvc.setProjectForConversation(convId, projectId),
  projectForConversation: (convId: number) => repo.projectForConversation(convId),
  // P3 mapping/provenance: confirm a MEDIUM suggestion (one tap -> a real user map), or dismiss it.
  confirmProjectSuggestion: (convId: number, projectId: number) => peopleSvc.setProjectForConversation(convId, projectId),
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

  // ---- C1: meeting features ----
  /** One graph entity for the Graph side card: its description, the entities it links to, and the
   *  meetings it appears in (edge evidence first, then memories that mention it by name). */
  entityDetail: async (id: number) => {
    const e = (await q("SELECT id,type,canonical_name,attrs,mention_count,first_seen,last_seen FROM entities WHERE id=?", [id]))[0] as any;
    if (!e) return null;
    let description = "";
    try { description = String(JSON.parse(e.attrs || "{}").description ?? ""); } catch { /* malformed attrs */ }
    const links = await q(
      `SELECT ed.relation, CASE WHEN ed.src_entity=? THEN 'out' ELSE 'in' END dir, n.id, n.type, n.canonical_name
       FROM edges ed JOIN entities n ON n.id = CASE WHEN ed.src_entity=? THEN ed.dst_entity ELSE ed.src_entity END
       WHERE ed.src_entity=? OR ed.dst_entity=? ORDER BY ed.weight DESC LIMIT 40`, [id, id, id, id]);
    const name = `%${String(e.canonical_name).toLowerCase()}%`;
    const meetings = await q(
      `SELECT c.id, COALESCE(m.title, c.title) title, COALESCE(c.started_at, c.created_at) started_at
       FROM conversations c LEFT JOIN memories m ON m.conversation_id=c.id
       WHERE c.id IN (SELECT json_extract(j.value,'$.conversation_id') FROM edges ed, json_each(ed.evidence) j
                      WHERE ed.src_entity=? OR ed.dst_entity=?)
          OR lower(COALESCE(m.title,'') || ' ' || COALESCE(m.summary,'') || ' ' || COALESCE(m.facts,'')) LIKE ?
       ORDER BY COALESCE(c.started_at, c.created_at) DESC LIMIT 20`, [id, id, name]);
    return { ...e, attrs: undefined, description, links, meetings };
  },
  // ---- C2: settings features ----
  /** Rename a person in place (enroll() would create a second row). Naming a provisional speaker
   *  makes it a real person. */
  renamePerson: async (pid: number, name: string) => {
    const n = name.trim();
    if (!n) throw new Error("A name can't be empty.");
    await run("UPDATE people SET canonical_name=?, provisional=0 WHERE id=?", [n, pid]);
    await persist();
  },
  /** Mark exactly one person as "me" (the device owner whose lines are channel 0 / "You"). */
  setMe: async (pid: number) => {
    await run("UPDATE people SET is_me=CASE WHEN id=? THEN 1 ELSE 0 END", [pid]);
    await persist();
  },
  // ---- end C2 ----
};

// Debug hook: expose the local API on window so on-device issues can be inspected/repaired live via
// the WebView DevTools (CDP). Dev-only — never exposed in production builds (the API includes a
// destructive `wipe`), so gate it strictly behind import.meta.env.DEV.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as any).__sutra = api;
  // DEV-only fixture seeder (lazy import keeps it out of production bundles).
  (window as any).__sutraDev = { seed: () => import("./devSeed").then((m) => m.seed()) };
}
