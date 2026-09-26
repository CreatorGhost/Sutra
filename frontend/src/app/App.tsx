import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { api } from "../local/sutra";
import { initDailyRecap } from "../lib/recapScheduler";
import { AUTH_EXPIRED_EVENT } from "../providers/cloudProvider";
import { desktop } from "../desktop/bridge";
import { AskAll } from "./AskAll";
import { Home } from "./Home";
import { LiveView } from "./LiveView";
import { MeetingView } from "./MeetingView";
import { RecorderProvider, useRecorder } from "./recorder";
import { SettingsSheet } from "./SettingsSheet";
import { Sidebar } from "./Sidebar";
import { useToast } from "./ui";

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
  const [toast, showToast] = useToast();
  const detail = pathname !== "/";

  // Desktop: the main process can deep-link us (pill "Open", tray).
  useEffect(() => desktop?.onNavigate((p) => nav(p)), [nav]);

  // Self-heal once per launch: finish any recording that was transcribed but never turned into notes
  // (app quit mid-processing, offline, crash). Delayed so it never competes with first paint.
  useEffect(() => {
    const t = setTimeout(() => { void api.reprocessIncomplete().catch(() => {}); }, 2500);
    return () => clearTimeout(t);
  }, []);

  // Phone: daily recap notification (native only; no-op elsewhere).
  useEffect(() => { void initDailyRecap().catch(() => {}); }, []);

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

  return (
    <div className={`shell${detail ? " detail" : ""}`}>
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      <main className="pane">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/m/:id" element={<MeetingView />} />
          <Route path="/live" element={<LiveView />} />
          <Route path="/ask" element={<AskAll />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {toast}
    </div>
  );
}
