import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { api } from "../local/sutra";
import { AUTH_EXPIRED_EVENT } from "../providers/cloudProvider";
import { desktop } from "../desktop/bridge";
import { pairingActive } from "../pairing/model";
import { syncNativeChrome } from "../lib/nativeChrome";
import { startPairingRuntime } from "../pairing/runtime";
import { AskAll } from "./AskAll";
import { DownloadChip } from "./DownloadChip";
import { useIntegrations } from "./integrations";
import { Home, PhoneSetup } from "./Home";
import { LiveView } from "./LiveView";
import { MeetingView } from "./MeetingView";
import { ProjectPage } from "./projects/ProjectPage";
import { ProjectsPage } from "./projects/ProjectsPage";
import { RecorderProvider, useRecorder } from "./recorder";
import { ProjectAsk } from "./meeting/ProjectAsk";
import { SettingsSheet, type SectionId } from "./SettingsSheet";
import { Sidebar } from "./Sidebar";
import { useToast } from "./ui";

// The force-graph canvas is heavy; load it only when the Graph is opened.
const GraphPage = lazy(() => import("./graph/GraphPage").then((m) => ({ default: m.GraphPage })));

export default function App() {
  return (
    <RecorderProvider>
      <Shell />
    </RecorderProvider>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const { state: rec, stop } = useRecorder();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId | undefined>(undefined);
  // Anything can open a specific Settings section (e.g. the Ask bar's "Manage engines…").
  useEffect(() => {
    const on = (e: Event) => { setSettingsSection((e as CustomEvent<SectionId | undefined>).detail); setSettingsOpen(true); };
    window.addEventListener("sutra:open-settings", on);
    return () => window.removeEventListener("sutra:open-settings", on);
  }, []);
  const [toast, showToast] = useToast();
  const detail = pathname !== "/";
  // Phone, first run: connect to the Mac before anything else (skippable). Desktop never sees this.
  const phone = !desktop && Capacitor.isNativePlatform();
  const [pairingSetup, setPairingSetup] = useState<boolean | null>(phone ? null : true);
  useEffect(() => {
    if (phone) void api.getSettings().then((s) => setPairingSetup(!!(s as Record<string, unknown>)["setup_pairing"])).catch(() => setPairingSetup(true));
  }, [phone]);

  // Desktop: the main process can deep-link us (pill "Open", tray).
  useEffect(() => desktop?.onNavigate((p) => nav(p)), [nav]);

  // Phone paired with a Mac: connect to it and send any recordings still waiting on the phone.
  useEffect(() => { startPairingRuntime(); }, []);

  // Self-heal once per launch: finish any recording that was transcribed but never turned into notes
  // (app quit mid-processing, offline, crash). Delayed so it never competes with first paint. A phone
  // paired with a Mac leaves this to its queue, which owns those recordings (two passes would race).
  useEffect(() => {
    const t = setTimeout(() => {
      void api.getSettings().then((s) => (!desktop && pairingActive(s) ? null : api.reprocessIncomplete())).catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  // Phone: daily recap notification (native only; no-op elsewhere).
  // MCP bridge (when sharing with AI tools is on) + daily recap (phone notification / desktop reminder).
  useIntegrations();

  useEffect(() => {
    const onExpired = () => showToast("Your Sutra session expired");
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [showToast]);

  // Android back: stop a live recording first, else go back, else minimise.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const h = CapApp.addListener("backButton", () => {
      if (rec.status === "recording") void stop();
      else if (window.location.pathname !== "/") nav(-1);
      else void CapApp.minimizeApp();
    });
    return () => { void h.then((x) => x.remove()); };
  }, [rec.status, stop, nav]);

  useEffect(() => { void syncNativeChrome(detail); }, [detail]);

  // ⌘/Ctrl+, opens settings; ⌘/Ctrl+K focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === ",") { e.preventDefault(); setSettingsOpen(true); }
      if (e.key.toLowerCase() === "k") { e.preventDefault(); (document.querySelector(".search input") as HTMLInputElement | null)?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (pairingSetup === null) return null;
  if (!pairingSetup) return <PhoneSetup put={async (patch) => { await api.putSettings(patch); setPairingSetup(true); }} />;

  return (
    <div className={`shell${detail ? " detail" : ""}`}>
      <Sidebar onOpenSettings={() => { setSettingsSection(undefined); setSettingsOpen(true); }} />
      <main className="pane">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/m/:id" element={<MeetingView />} />
          <Route path="/live" element={<LiveView />} />
          <Route path="/ask" element={<AskAll />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/graph" element={<Suspense fallback={null}><GraphPage /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {settingsOpen && <SettingsSheet initialSection={settingsSection} onClose={() => setSettingsOpen(false)} />}
      <ProjectAsk />
      <DownloadChip onDone={showToast} />
      {toast}
    </div>
  );
}
