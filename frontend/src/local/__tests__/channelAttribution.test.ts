// F4 — channel-aware speaker attribution.
//
// Covers the PURE segment-attribution step that ingest applies (owner / remote / single-channel
// pass-through; multichannel resolves the owner person_id + drops the owner voiceprint; single-channel
// is byte-for-byte pre-F4), and the cluster-exclusion invariant: owner turns carry no voiceprint, so
// clusterSession's `embedded` filter excludes them and they can't join a remote cluster.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attributeSegments, OWNER_LABEL, REMOTE_PREFIX } from "../channelAttribution";

describe("attributeSegments (segment-attribution step ingest applies)", () => {
  it("owner via channel=0 (non-'0' speaker) → owner label, owner person_id, voiceprint dropped", () => {
    const [r] = attributeSegments([{ speaker: "anything", channel: 0, embedding: [1, 2] }], 7);
    expect(r).toEqual({ session_speaker_label: OWNER_LABEL, person_id: 7, voiceprint: null });
    // owner label is a reserved constant: not a cluster id, not remote-namespaced.
    expect(r.session_speaker_label).not.toMatch(/^c\d+$/);
    expect(r.session_speaker_label.startsWith(REMOTE_PREFIX)).toBe(false);
  });

  it("remote via channel=1 → remote-namespaced label distinct from owner & pass-through", () => {
    const [r] = attributeSegments([{ speaker: "A", channel: 1, embedding: [3, 4] }], 7);
    expect(r.session_speaker_label).toBe(`${REMOTE_PREFIX}A`);
    expect(r.session_speaker_label).not.toBe(OWNER_LABEL);
    expect(r.session_speaker_label).not.toBe("A"); // distinct from a single-channel pass-through of "A"
  });

  it("single-channel pass-through also covers explicit undefined channel/is_me", () => {
    const [r] = attributeSegments([{ speaker: "B", channel: undefined, is_me: undefined, embedding: [5] }], 7);
    expect(r).toEqual({ session_speaker_label: "B", person_id: null, voiceprint: [5] });
  });

  it("multichannel: ch0/is_me → owner label + owner person_id + null voiceprint; ch1 → remote label + own voiceprint + null person_id", () => {
    const OWNER_ID = 7;
    const segs = [
      { speaker: "0", channel: 0, is_me: true, embedding: [0.1, 0.2] }, // owner — voiceprint must be dropped
      { speaker: "A", channel: 1, embedding: [0.3, 0.4] },             // remote — voiceprint kept
      { speaker: "B", channel: 1, embedding: [0.5, 0.6] },             // remote — voiceprint kept
    ];
    const rows = attributeSegments(segs, OWNER_ID);

    expect(rows[0]).toEqual({ session_speaker_label: OWNER_LABEL, person_id: OWNER_ID, voiceprint: null });
    expect(rows[1]).toEqual({ session_speaker_label: `${REMOTE_PREFIX}A`, person_id: null, voiceprint: [0.3, 0.4] });
    expect(rows[2]).toEqual({ session_speaker_label: `${REMOTE_PREFIX}B`, person_id: null, voiceprint: [0.5, 0.6] });
  });

  it("multichannel with owner not enrolled: owner person_id is null (no shortcut to a wrong row)", () => {
    const rows = attributeSegments([{ speaker: "0", channel: 0, is_me: true, embedding: [1, 2] }], null);
    expect(rows[0].person_id).toBe(null);
    expect(rows[0].voiceprint).toBe(null);
    expect(rows[0].session_speaker_label).toBe(OWNER_LABEL);
  });

  it("single-channel: identical to pre-F4 — label===speaker, voiceprint stored when present, no owner person_id", () => {
    const segs = [
      { speaker: "A", embedding: [0.1, 0.2] },
      { speaker: "B", embedding: null },
      { speaker: "A" },
    ];
    const rows = attributeSegments(segs, 99 /* would-be owner; must be ignored for untagged segments */);
    expect(rows[0]).toEqual({ session_speaker_label: "A", person_id: null, voiceprint: [0.1, 0.2] });
    expect(rows[1]).toEqual({ session_speaker_label: "B", person_id: null, voiceprint: null });
    expect(rows[2]).toEqual({ session_speaker_label: "A", person_id: null, voiceprint: null });
  });
});

// --- owner excluded from clustering -------------------------------------------------------------
// clusterSession reads turns via repo.turnsForClustering and only clusters turns whose `vec` is set.
// Owner turns are inserted with a null voiceprint (above), so they present as vec=null here and must be
// excluded from every cluster; remote turns (with voiceprints) still cluster as today.
vi.mock("../repo", () => {
  const setTurnSpeakerLabel = vi.fn(async () => {});
  return {
    __esModule: true,
    turnsForClustering: vi.fn(),
    setTurnSpeakerLabel,
  };
});

import * as repo from "../repo";
import { clusterSession } from "../speakerId";

describe("clusterSession excludes owner (voiceprint-less) turns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owner turns (no vec) never form/join a cluster; remotes still cluster", async () => {
    // Two distinct remote speakers (orthogonal vectors), each with two long turns, plus two owner turns
    // that carry NO voiceprint. The owner turns must be absent from the relabelled set.
    const remoteVecA = [1, 0, 0];
    const remoteVecB = [0, 1, 0];
    const rows = [
      { id: 1, text: "owner says hi", cloud: "me", start_ts: 0, end_ts: 3, vec: null },       // owner — excluded
      { id: 2, text: "remote a one", cloud: "rA", start_ts: 3, end_ts: 6, vec: remoteVecA },
      { id: 3, text: "remote a two", cloud: "rA", start_ts: 6, end_ts: 9, vec: remoteVecA },
      { id: 4, text: "owner says bye", cloud: "me", start_ts: 9, end_ts: 12, vec: null },      // owner — excluded
      { id: 5, text: "remote b one", cloud: "rB", start_ts: 12, end_ts: 15, vec: remoteVecB },
      { id: 6, text: "remote b two", cloud: "rB", start_ts: 15, end_ts: 18, vec: remoteVecB },
    ];
    (repo.turnsForClustering as any).mockResolvedValue(rows);

    const clusters = await clusterSession(1);

    // Two remote speakers recovered.
    expect(clusters.length).toBe(2);

    // Collect every turn id that got (re)labelled into a cluster.
    const labelled = new Set<number>();
    for (const call of (repo.setTurnSpeakerLabel as any).mock.calls) {
      for (const id of call[0] as number[]) labelled.add(id);
    }
    // Owner turns (1 and 4) carried no voiceprint → excluded from clustering, so they are NOT relabelled.
    expect(labelled.has(1)).toBe(false);
    expect(labelled.has(4)).toBe(false);
    // Remote turns clustered as usual.
    for (const id of [2, 3, 5, 6]) expect(labelled.has(id)).toBe(true);
  });
});
