// Project folders through the REAL repo on a REAL in-memory SQLite: which folders Ask may read for a
// meeting / a project / a paired phone's hint, and that Ask hands them to the engine.
import { describe, it, expect, vi, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { adapt } from "../../storage/desktopAdapter";
import { runMigrations } from "../../storage/migrate";

const raw = new Database(":memory:");
runMigrations({
  exec: (sql) => raw.exec(sql),
  getUserVersion: () => Number(raw.pragma("user_version", { simple: true })),
  setUserVersion: (v) => raw.exec(`PRAGMA user_version=${v};`),
  columns: (t) => (raw.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => String(r.name)),
});
const store = adapt(raw as any);
vi.mock("../db", () => ({ q: (s: string, p?: any[]) => store.q(s, p), run: (s: string, p?: any[]) => store.run(s, p), exec: (s: string) => store.exec(s), persist: async () => {} }));

let repo: typeof import("../repo");
beforeAll(async () => { repo = await import("../repo"); });

async function meeting(uid: string) {
  const s = await repo.createSession("electron", "meeting", "Zoom");
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", text: "The retry logic lives in the worker.", start_ts: 0, end_ts: 2, abs_start: "2026-10-01T10:00:00.000Z" });
  const { segmentSession } = await import("../segmentation");
  const [cid] = await segmentSession(s.id);
  await store.run("UPDATE conversations SET uid=? WHERE id=?", [uid, cid]);
  return cid;
}

describe("project folders in the database", () => {
  it("links folders to a project and lists them", async () => {
    const pid = await repo.createProject("Acme");
    await repo.addProjectFolder(pid, "/code/acme");
    await repo.addProjectFolder(pid, "/code/acme");          // idempotent
    await repo.addProjectFolder(pid, "/code/acme-api");
    expect((await repo.getProject(pid))?.folders).toEqual(["/code/acme", "/code/acme-api"]);
    expect((await repo.listProjects()).find((p: any) => p.id === pid)).toMatchObject({ folder_count: 2, code_access: true });
    await repo.removeProjectFolder(pid, "/code/acme-api");
    expect(await repo.folderStillLinked("/code/acme-api")).toBe(false);
    expect(await repo.folderStillLinked("/code/acme")).toBe(true);
  });

  it("gives Ask a meeting's project folders, and a paired Mac finds them from the phone's hint", async () => {
    const pid = await repo.createProject("Billing");
    await repo.addProjectFolder(pid, "/code/billing");
    const cid = await meeting("uid-billing-1");
    await repo.setConversationProject(cid, pid);
    expect(await repo.askScopeForConversation(cid)).toEqual({ projectId: pid, projectName: "Billing", folders: ["/code/billing"], meetingUid: "uid-billing-1" });
    // On the Mac: the phone names the meeting (by uid) or the project (by name).
    expect((await repo.askScopeFromHint({ meetingUid: "uid-billing-1" }))?.folders).toEqual(["/code/billing"]);
    expect((await repo.askScopeFromHint({ projectName: "  billing " }))?.folders).toEqual(["/code/billing"]);
    expect(await repo.askScopeFromHint({ projectName: "Nope" })).toBeNull();
    expect(await repo.askScopeFromHint({ meetingUid: 42 as any })).toBeNull();
    // Code access off: still the project, no folders.
    await repo.updateProject(pid, { code_access: false });
    expect((await repo.askScopeForConversation(cid))?.folders).toEqual([]);
    // A meeting outside any project still carries its uid (a paired Mac may know its project).
    const loose = await meeting("uid-loose");
    expect(await repo.askScopeForConversation(loose)).toEqual({ projectId: null, projectName: "", folders: [], meetingUid: "uid-loose" });
  });

  it("deleting a project drops its folder links", async () => {
    const pid = await repo.createProject("Temp");
    await repo.addProjectFolder(pid, "/code/temp");
    await repo.deleteProject(pid);
    expect(await repo.folderStillLinked("/code/temp")).toBe(false);
  });

  it("Ask about a meeting hands the engine its project's folders", async () => {
    const pid = await repo.createProject("Search");
    await repo.addProjectFolder(pid, "/code/search");
    const cid = await meeting("uid-search");
    await repo.setConversationProject(cid, pid);
    const chat = vi.fn(async () => ({ answer: "It's in src/worker.ts." }));
    const { askMeeting } = await import("../notes");
    const a = await askMeeting(cid, "Where is the retry logic?", { chat } as any);
    expect(a).toBe("It's in src/worker.ts.");
    expect((chat.mock.calls[0] as any[])[3]).toMatchObject({ projectName: "Search", folders: ["/code/search"], meetingUid: "uid-search" });
  });
});
