// Typed renderer-side view of the Electron preload bridge (electron/preload.ts). Every accessor is
// optional-chained so the same UI runs in the browser / on Android where the bridge is absent.
import type { Detection } from "../shared/meetingRules";
import type { AgentId, AgentRequest, AgentStatus } from "../shared/agentProtocol";
import type { LocalSegment } from "../shared/localModels";

export type { AgentStatus };
export interface SttStatus { binary: string | null; installed: string[]; downloading: { id: string; received: number; total: number } | null }
export interface SttProgress { id: string; received: number; total: number; done?: boolean; error?: string }

export type DetectionState = { active: (Detection & { icon?: string }) | null; visible: boolean };
export interface DesktopPrefs { detectMeetings: boolean; autoStop: boolean }
export type PillMode = "hidden" | "detected" | "recording" | "processing" | "done";
export interface RecorderSnapshot {
  status: "idle" | "starting" | "recording" | "processing";
  startedAt?: number | null;
  app?: string | null;
  level?: number;
  conversationId?: number | null;
  error?: string | null;
}
export interface PillState {
  mode: PillMode;
  app?: string | null;
  service?: string;
  icon?: string;
  recorder: RecorderSnapshot;
  conversationId?: number | null;
}

type Unsub = () => void;
export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  detection: { get(): Promise<DetectionState>; onChange(cb: (s: DetectionState) => void): Unsub };
  recorder: { publish(s: RecorderSnapshot): void };
  pill: { onState(cb: (s: PillState) => void): Unsub; action(type: "record" | "stop" | "dismiss" | "open"): void; resize(width: number): void };
  prefs: { get(): Promise<DesktopPrefs>; set(patch: Partial<DesktopPrefs>): Promise<DesktopPrefs> };
  permissions: { get(): Promise<{ microphone: string; screen: string }>; request(kind: "microphone" | "screen"): Promise<boolean> };
  onNavigate(cb: (path: string) => void): Unsub;
  icon(appName: string): Promise<string | null>;
  ai: { detect(refresh?: boolean): Promise<AgentStatus[]>; run(id: AgentId, req: AgentRequest): Promise<{ text: string; json?: unknown }> };
  stt: {
    status(): Promise<SttStatus>;
    download(id: string): Promise<void>;
    cancel(): Promise<void>;
    remove(id: string): Promise<void>;
    transcribe(wav: ArrayBuffer, opts: { model: string; language?: string | null }): Promise<{ text: string; duration: number; segments: LocalSegment[] }>;
    onProgress(cb: (p: SttProgress) => void): Unsub;
  };
}

export const desktop: DesktopBridge | null =
  typeof globalThis !== "undefined" && (globalThis as any).sutraDesktop?.isDesktop ? ((globalThis as any).sutraDesktop as DesktopBridge) : null;

export const isMacDesktop = desktop?.platform === "darwin";
