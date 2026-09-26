// PURE: how a transcript turn's speaker is shown to people. Stored labels are machine ids:
//   "me"           → the device owner (mic channel of a meeting recording)
//   "r0", "rA"     → a remote participant from the meeting channel, as diarized
//   "1", "2", "A"  → a voiceprint cluster / raw diarizer label (ambient recordings)
// A named person (person_name) always wins.

export interface SpeakerTurn {
  person_name?: string | null;
  is_me?: number | boolean | null;
  session_speaker_label?: string | null;
}

export function speakerName(t: SpeakerTurn): string {
  if (t.person_name) return String(t.person_name);
  const label = String(t.session_speaker_label ?? "").trim();
  if (!label || label === "me" || t.is_me) return "Me";
  const bare = label.replace(/^r(?=.)/, "").replace(/^speaker[\s_-]*/i, "");
  if (/^\d+$/.test(bare)) return `Speaker ${Number(bare) + (label.startsWith("r") ? 1 : 0)}`;
  return `Speaker ${bare.toUpperCase()}`;
}

/** True when the turn belongs to the device owner. */
export function isMe(t: SpeakerTurn): boolean {
  return !!t.is_me || (!t.person_name && String(t.session_speaker_label ?? "") === "me");
}
