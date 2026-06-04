import { Suspense, lazy, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Nav } from "./components/Nav";
import { Header } from "./components/Header";
import { Onboarding } from "./components/Onboarding";
import { initDailyRecap } from "./lib/recapScheduler";
import { api } from "./local/sutra";

const Capture = lazy(() => import("./pages/Capture"));
const Memory = lazy(() => import("./pages/Memory"));
const ConversationDetail = lazy(() => import("./pages/ConversationDetail"));
const GraphPage = lazy(() => import("./pages/GraphPage"));
const Chat = lazy(() => import("./pages/Chat"));
const Settings = lazy(() => import("./pages/Settings"));

export default function App() {
  // First-run gate: show onboarding until the user completes it (flag in localStorage = race-free).
  const [onboarded, setOnboarded] = useState<boolean>(() => {
    try { return localStorage.getItem("sutra_onboarded") === "1"; } catch { return false; }
  });

  // Once onboarded, ensure the daily on-device recap notification is scheduled (native only; no-op on web).
  useEffect(() => { if (onboarded) initDailyRecap().catch(() => {}); }, [onboarded]);

  // Self-heal: reprocess any recording that was transcribed but never fully turned into a memory
  // (app killed/backgrounded mid-process, proxy was down, or a prior build crashed). Runs once after
  // onboarding, after a short delay so it doesn't compete with first paint. Hybrid only; no-ops otherwise.
  useEffect(() => {
    if (!onboarded) return;
    const t = setTimeout(() => {
      api.reprocessIncomplete().then((r: any) => { if (r?.recovered) console.info("recovered", r.recovered, "memory(ies)"); }).catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, [onboarded]);

  if (!onboarded) return <Onboarding onDone={() => setOnboarded(true)} />;

  return (
    <div className="app">
      <Header />
      <Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 120 }} /></div>}>
        <Routes>
          <Route path="/" element={<Capture />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/conversation/:id" element={<ConversationDetail />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Nav />
    </div>
  );
}
