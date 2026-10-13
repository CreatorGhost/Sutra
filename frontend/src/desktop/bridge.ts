// Typed renderer-side view of the Electron preload bridge (electron/preload.ts). Every accessor is
// optional-chained so the same UI runs in the browser / on Android where the bridge is absent.
import type { Detection } from "../shared/meetingRules";
import type { AgentId, AgentRequest } from "../shared/agentProtocol";
import type { LocalSegment } from "../shared/localModels";

export interface AgentStatus { id: AgentId; label: string; path: string | null; version: string | null; install: string }
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
  pill: { onState(cb: (s: PillState) => void): Unsub; action(type: "record" | "stop" | "dismiss" | "open"): void; resize(width: number): void };
  prefs: { get(): Promise<DesktopPrefs>; set(patch: Partial<DesktopPrefs>): Promise<DesktopPrefs> };
  permissions: { get(): Promise<{ microphone: string; screen: string }>; request(kind: "microphone" | "screen"): Promise<boolean> };
  onNavigate(cb: (path: string) => void): Unsub;
  icon(appName: string): Promise<string | null>;
  ai: { detect(): Promise<AgentStatus[]>; run(id: AgentId, req: AgentRequest): Promise<{ text: string; json?: unknown }> };
  stt: {
    status(): Promise<SttStatus>;
    download(id: string): Promise<void>;
    cancel(): Promise<void>;
    remove(id: string): Promise<void>;
    transcribe(wav: ArrayBuffer, opts: { model: string; language?: string | null }): Promise<{ text: string; duration: number; segments: LocalSegment[] }>;
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
  /** Save a backup file via the native save dialog; null when cancelled. */
  backup?: { save(json: string, filename: string): Promise<string | null> };
}

export const desktop: DesktopBridge | null =
  typeof globalThis !== "undefined" && (globalThis as any).sutraDesktop?.isDesktop ? ((globalThis as any).sutraDesktop as DesktopBridge) : null;

export const isMacDesktop = desktop?.platform === "darwin";
