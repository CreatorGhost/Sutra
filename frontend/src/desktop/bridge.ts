// Typed renderer-side view of the Electron preload bridge (electron/preload.ts). Every accessor is
// optional-chained so the same UI runs in the browser / on Android where the bridge is absent.
import type { Detection } from "../shared/meetingRules";
import type { AgentId, AgentRequest, AgentStatus } from "../shared/agentProtocol";
import type { FolderScan } from "../shared/projectFolders";

export interface FrameInfo { name: string; at: number; score: number }
export interface RecordingStatus { session: number; createdAt: number; frames: number; firstAt: number | null; lastAt: number | null; audioBytes: number; audioMime: string | null }
import type { RelaySetupState } from "../shared/pairing/relaySetup";
import type { LocalTranscription, SpeechProgress, SpeechStatus, SpeechTranscribeOpts } from "../shared/speechModels";
import type { ExecMessage, ExecResult, PairingStatus, PairingUpdate } from "../shared/pairing/hostApi";

export type { AgentStatus, PairingStatus, PairingUpdate };
export type SttStatus = SpeechStatus;
export type SttProgress = SpeechProgress;

export type DetectionState = { active: (Detection & { icon?: string }) | null; visible: boolean };
export interface DesktopPrefs {
  detectMeetings: boolean; autoStop: boolean;
  /** Engines the user uses; null = not chosen yet (all are checked). */ enabledEngines: AgentId[] | null;
  /** Take screenshots (and keep the audio) during meetings, for notes that see what was shown. */ captureScreen?: boolean;
}
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
  /** Set on a MacBook's notched screen: the pill becomes an island around the camera. */
  notch?: { width: number; height: number } | null;
  /** Hidden by the user while recording: tucked behind the camera; hovering the notch still opens it. */
  tucked?: boolean;
}

export type McpClientId = "claude-code" | "codex" | "cursor" | "gemini" | "claude-desktop";
export interface McpClientStatus {
  id: McpClientId;
  label: string;
  format: "claude-cli" | "toml" | "json";
  detected: boolean;
  /** "stale" = set up, but with an older pairing token. */
  configured: "no" | "yes" | "stale";
  configPath: string;
  install: string;
}
export interface McpServerStatus { ready: boolean; script: string | null; hint: string | null }
export interface McpWriteResult { path: string; backup: string | null; written: string; message: string }

type Unsub = () => void;
export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  detection: { get(): Promise<DetectionState>; onChange(cb: (s: DetectionState) => void): Unsub };
  recorder: { publish(s: RecorderSnapshot): void };
  pill: { onState(cb: (s: PillState) => void): Unsub; action(type: "record" | "stop" | "dismiss" | "open" | "hide"): void; resize(width: number): void; hover(on: boolean): void };
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
    transcribe(wav: ArrayBuffer, opts: SpeechTranscribeOpts): Promise<LocalTranscription>;
    onProgress(cb: (p: SttProgress) => void): Unsub;
  };
  /** Connect Sutra's MCP server to the user's AI tools (electron/mcpConnect.ts). */
  mcp?: {
    status(token: string): Promise<{ server: McpServerStatus; clients: McpClientStatus[] }>;
    snippet(id: McpClientId | "other", token: string, url?: string): Promise<string>;
    install(id: McpClientId, token: string, url?: string): Promise<McpWriteResult>;
    remove(id: McpClientId): Promise<McpWriteResult>;
    reveal(path: string): Promise<void>;
  };
  /** A meeting's screenshots and audio, encrypted, until the notes are confirmed (or 7 days pass). */
  media?: {
    frame(sid: number, at: number, bytes: Uint8Array, score: number): Promise<FrameInfo>;
    audio(sid: number, chunk: Uint8Array, mime: string): Promise<number>;
    status(sid: number): Promise<RecordingStatus | null>;
    frames(sid: number): Promise<FrameInfo[]>;
    readFrame(sid: number, name: string): Promise<Uint8Array>;
    readAudio(sid: number): Promise<{ bytes: Uint8Array; mime: string | null } | null>;
    keep(sid: number, name: string, cid: number): Promise<string>;
    readKept(cid: number, name: string): Promise<Uint8Array>;
    deleteKept(cid: number, name?: string): Promise<void>;
    deleteSession(sid: number): Promise<void>;
  };
  /** Code folders linked to projects. Only folders picked in the system dialog are ever opened. */
  folders?: {
    /** The system folder picker; the chosen folder's real path, or null when cancelled. */
    pick(): Promise<string | null>;
    forget(path: string): Promise<void>;
    scan(path: string): Promise<FolderScan>;
    /** Write a new AGENTS.md (never overwrites); returns its path. */
    writeAgents(path: string, content: string): Promise<string>;
    /** Show a folder (or a file inside it) in Finder; false when it isn't there. */
    reveal(path: string, rel?: string): Promise<boolean>;
  };
  /** Phones paired with this computer (Settings → Phones; electron/pairing/*). */
  pairing?: {
    status(): Promise<PairingStatus>;
    /** A fresh pairing QR (replaces any open one). */
    newOffer(): Promise<PairingStatus>;
    cancelOffer(): Promise<void>;
    removeDevice(id: string): Promise<boolean>;
    /** `hostSecret` omitted keeps the saved one. */
    setRelay(p: { url?: string; hostSecret?: string; enabled?: boolean }): Promise<PairingStatus>;
    setLan(on: boolean): Promise<PairingStatus>;
    onChange(cb: (u: PairingUpdate) => void): Unsub;
    /** Serve phone requests forwarded by main (one handler, the main window's). */
    serve(cb: (req: ExecMessage) => void): Unsub;
    result(r: ExecResult): void;
    /** Something phones care about changed (engine, model, speech). */
    hostChanged(): void;
    /** One-click "Reach from anywhere" on the user's own Cloudflare account. */
    relay: {
      state(): Promise<RelaySetupState>;
      start(o?: { rotateSecret?: boolean }): Promise<RelaySetupState>;
      chooseAccount(id: string): Promise<RelaySetupState>;
      continueSetup(): Promise<RelaySetupState>;
      remove(o?: { localOnly?: boolean }): Promise<RelaySetupState>;
      cancel(): Promise<RelaySetupState>;
      onChange(cb: (s: RelaySetupState) => void): Unsub;
    };
  };
  /** Save a backup file via the native save dialog; null when cancelled. */
  backup?: { save(json: string, filename: string): Promise<string | null> };
}

export const desktop: DesktopBridge | null =
  typeof globalThis !== "undefined" && (globalThis as any).sutraDesktop?.isDesktop ? ((globalThis as any).sutraDesktop as DesktopBridge) : null;

export const isMacDesktop = desktop?.platform === "darwin";
