import { describe, expect, it } from "vitest";
import { projectFolders } from "../projects/model";

const m = (id: number, project_id: number | null, day: number, title: string) => ({ id, project_id, title, started_at: `2026-10-${String(day).padStart(2, "0")} 10:00:00` });
const rows = [m(1, 1, 2, "Mantis backend"), m(2, 2, 9, "MCS admin demo"), m(3, 1, 5, "Mantis Slack"), m(4, null, 8, "Voice note"), m(5, 99, 1, "Orphan")];
const projects = [{ id: 1, name: "Mantis" }, { id: 2, name: "MCS" }, { id: 3, name: "Empty" }];
const hit = (r: any, q: string) => r.title.toLowerCase().includes(q.toLowerCase());

describe("sidebar project folders", () => {
  it("one folder per project, latest activity first, newest meetings first, the rest under 'Not in a project'", () => {
    const f = projectFolders(rows, projects, "", hit);
    expect(f.map((x) => x.project?.name ?? null)).toEqual(["MCS", "Mantis", "Empty", null]);
    expect(f[1].meetings.map((x) => x.id)).toEqual([3, 1]);
    expect(f[3].meetings.map((x) => x.id)).toEqual([4, 5]);   // a deleted project's meeting isn't lost
  });

  it("search narrows every folder; a project-name hit shows all its meetings", () => {
    expect(projectFolders(rows, projects, "slack", hit).map((x) => [x.project?.name, x.meetings.map((y) => y.id), x.total])).toEqual([["Mantis", [3], 2]]);
    expect(projectFolders(rows, projects, "mcs", hit).map((x) => [x.project?.name, x.meetings.length])).toEqual([["MCS", 1]]);
    expect(projectFolders(rows, projects, "empty", hit).map((x) => x.project?.name)).toEqual(["Empty"]);
  });
});
