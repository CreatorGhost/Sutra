import { describe, expect, it, vi } from "vitest";
vi.mock("../../local/sutra", () => ({ api: {} }));
import { withStatus, type RecorderState } from "../recorder";

const st = (capture: RecorderState["capture"], saving: number) => withStatus({ capture, saving } as RecorderState).status;

describe("recorder status", () => {
  it("a new recording wins over notes still saving in the background", () => {
    expect(st("recording", 1)).toBe("recording");
    expect(st("starting", 2)).toBe("starting");
  });
  it("shows processing only while nothing is capturing", () => {
    expect(st("idle", 1)).toBe("processing");
    expect(st("idle", 0)).toBe("idle");
  });
});
