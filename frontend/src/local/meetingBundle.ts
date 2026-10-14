// STUB — the real module (export/import of one finished meeting, no audio) lands with the Mac side.
export type MeetingBundle = { v: 1; uid: string } & Record<string, unknown>;

export async function exportMeetingBundle(_conversationId: number, _origin?: { deviceName: string; platform: string }): Promise<MeetingBundle> {
  throw new Error("not implemented");
}
