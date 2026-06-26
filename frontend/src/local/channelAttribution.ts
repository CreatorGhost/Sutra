// F4 — channel-aware speaker attribution (online-meeting / multichannel capture).
//
// Two-channel capture (see docs/MEETING-CAPTURE-SPEC.md) splits audio into channel 0 = the device
// owner's mic ("Me") and channel 1 = the remotes (system audio). That turns the hardest part of
// diarization — "is this Me or a remote?" — into a channel-index lookup, so:
//   • channel 0 / is_me=true turns get a RESERVED owner label and carry NO voiceprint (the owner is
//     known deterministically; clustering would only add noise and clusterSession's `embedded` filter
//     excludes voiceprint-less turns, so the owner can never join a remote cluster), while
//   • channel 1 turns keep their per-turn voiceprint so the existing ECAPA clustering still NAMES the
//     remotes across windows.
//
// Single-channel (ambient) capture has NO channel/is_me on its segments and must behave EXACTLY as
// before F4: label === segment.speaker, voiceprint kept, no owner shortcut. This module is PURE
// (no DB, no I/O) and unit-tested directly; `ingest` applies its decision and resolves the owner
// person row once per window.

/** Reserved session_speaker_label for the device owner (channel 0 / is_me). A constant that is NOT a
 *  voiceprint-cluster id ("c1".."cN"), NOT a remote-namespaced id, and NOT a raw cloud diarizer label,
 *  so it can never alias any of them. */
export const OWNER_LABEL = "me" as const;

/** Namespace prefix for a remote (channel 1) speaker's session label, derived from the segment's own
 *  diarizer speaker. Distinct from the owner label AND from a single-channel pass-through label (which
 *  is the bare speaker), so a multichannel remote "0" can't collide with an ambient pass-through "0"
 *  or with a cluster id. */
export const REMOTE_PREFIX = "r" as const;

/** A diarized segment as seen by attribution: the diarizer speaker plus the optional multichannel tags. */
type ChannelSegment = { speaker: string; channel?: number; is_me?: boolean };

/** A turn-row's channel-derived fields, ready for repo.insertTurn. */
export interface AttributedTurn {
  session_speaker_label: string;
  /** Resolved owner person_id for owner turns (the people row where is_me=1); null for everyone else
   *  (remotes are named later by voiceprint clustering, exactly as today). */
  person_id: number | null;
  /** The per-turn ECAPA voiceprint to store, or null when none / when dropped for the owner. */
  voiceprint: number[] | null;
}

/** PURE segment-attribution step used by ingestWindow. Channel-aware:
 *   • owner  (is_me === true OR channel === 0) → reserved owner label, owner person_id, voiceprint DROPPED.
 *   • remote (channel === 1, is_me not set)     → remote-namespaced label, null person_id, voiceprint KEPT.
 *   • neither channel nor is_me present         → UNCHANGED pre-F4 behavior: diarizer speaker passed
 *     straight through, null person_id, voiceprint KEPT.
 *  The owner person_id is resolved ONCE per window (the people row where is_me=1, or null if the owner
 *  isn't enrolled). Single-channel windows come out byte-for-byte pre-F4. No DB, no I/O. */
export function attributeSegments<T extends ChannelSegment & { embedding?: number[] | null }>(
  segments: T[],
  ownerPersonId: number | null,
): AttributedTurn[] {
  return segments.map((s) => {
    // Single-channel pass-through: no multichannel tags at all → identical to pre-F4 behavior.
    if (typeof s.channel !== "number" && typeof s.is_me !== "boolean") {
      return { session_speaker_label: s.speaker, person_id: null, voiceprint: s.embedding ?? null };
    }
    // Owner: explicit is_me, or channel 0 → owner person_id, voiceprint dropped so it never clusters.
    if (s.is_me === true || s.channel === 0) {
      return { session_speaker_label: OWNER_LABEL, person_id: ownerPersonId, voiceprint: null };
    }
    // Remote (channel 1, or tagged-but-not-owner): namespace the diarizer speaker so it stays distinct
    // from the owner label and from an ambient pass-through, and keep its voiceprint for ECAPA naming.
    return { session_speaker_label: `${REMOTE_PREFIX}${s.speaker}`, person_id: null, voiceprint: s.embedding ?? null };
  });
}
