import { Suspense, lazy, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { Nav } from "./components/Nav";
import { Header } from "./components/Header";
import { Onboarding } from "./components/Onboarding";
import { AccountGate } from "./components/AccountStep";
import { ScrollMemory } from "./components/ScrollMemory";
import { captureActive, endCapture } from "./lib/captureGuard";
import { isSignedIn, clearToken } from "./lib/auth";
import { AUTH_EXPIRED_EVENT } from "./providers/cloudProvider";
import { initDailyRecap } from "./lib/recapScheduler";
import { initMcpBridge } from "./lib/mcpBridge";
import { api } from "./local/sutra";

const Capture = lazy(() => import("./pages/Capture"));
const Meeting = lazy(() => import("./pages/Meeting"));
const Memory = lazy(() => import("./pages/Memory"));
const ConversationDetail = lazy(() => import("./pages/ConversationDetail"));
const GraphPage = lazy(() => import("./pages/GraphPage"));
const Chat = lazy(() => import("./pages/Chat"));
const Settings = lazy(() => import("./pages/Settings"));
const CaptureSettings = lazy(() => import("./pages/settings/CaptureSettings"));
const ContextSettings = lazy(() => import("./pages/settings/ContextSettings"));
const ProjectsHub = lazy(() => import("./pages/settings/ProjectsHub"));
const ProjectDetail = lazy(() => import("./pages/settings/ProjectDetail"));
const PeopleSettings = lazy(() => import("./pages/settings/PeopleSettings"));
const ConnectionsSettings = lazy(() => import("./pages/settings/ConnectionsSettings"));
const RecapSettings = lazy(() => import("./pages/settings/RecapSettings"));
const AdvancedSettings = lazy(() => import("./pages/settings/AdvancedSettings"));
const SignIn = lazy(() => import("./pages/SignIn"));
const AccountSettings = lazy(() => import("./pages/settings/AccountSettings"));
const LegalDoc = lazy(() => import("./pages/LegalDoc"));
// NOTE: the marketing landing site (src/landing/*, src/landing-pro/*) is intentionally NOT routed
// from the shipped app — routing it here bundled ~10.5k LOC + the three.js/@react-three/gsap stack
// (the react-three-fiber chunk alone was the largest JS asset) into the Android/iOS/desktop build for
// pages a WebView can't even navigate to. The source stays in the repo; serve it as a separate static
// marketing build once a variant is chosen. See docs/AUDIT-FIXES.md.

export default function App() {
  // First-run gate: show onboarding until the user completes it (flag in localStorage = race-free).
  const [onboarded, setOnboarded] = useState<boolean>(() => {
    try { return localStorage.getItem("sutra_onboarded") === "1"; } catch { return false; }
  });

  // Account gate (account-required decision): an onboarded install with no session — app update
  // from a pre-account build, sign-out, expired/rejected token — sees the sign-in gate once.
  // Local memory is untouched behind it.
  const [signedIn, setSignedIn] = useState<boolean>(() => isSignedIn());

  // When the proxy rejects our token (expired account session), re-auth — but NEVER tear down the
  // UI mid-recording: the gate is deferred until the live capture ends (the failed window is
  // already saved and will reprocess after sign-in).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onExpired = () => {
      clearToken();
      const flip = () => {
        if (captureActive()) timer = setTimeout(flip, 10000);
        else setSignedIn(false);
      };
      flip();
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => { window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired); if (timer) clearTimeout(timer); };
  }, []);

  // Once onboarded, ensure the daily on-device recap notification is scheduled (native only; no-op on web).
  useEffect(() => { if (onboarded) initDailyRecap().catch(() => {}); }, [onboarded]);

  // Once onboarded, start the outbound MCP bridge (no-ops unless External access is enabled in Settings).
  useEffect(() => { if (onboarded) initMcpBridge().catch(() => {}); }, [onboarded]);

  // Re-apply prefs onboarding stashed when the engine couldn't persist them yet (benign FTS5 limit on
  // web). Remove the key only on success so a failure retries on the next launch.
  useEffect(() => {
    if (!onboarded) return;
    (async () => {
      try {
        const raw = localStorage.getItem("sutra_pending_prefs");
        if (!raw) return;
        const { transcript_lang, mode } = JSON.parse(raw);
        await api.putSettings({ transcript_lang });
        await api.setMode(mode);
        localStorage.removeItem("sutra_pending_prefs");
      } catch { /* retry next launch */ }
    })();
  }, [onboarded]);

  // Android hardware back: end a live recording first (save it), else go back one route, else minimize
  // the app instead of letting the WebView fall off the history stack. Native only; no-op on web.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handle = CapApp.addListener("backButton", () => {
      if (captureActive()) { void endCapture(); window.history.back(); }
      else if (window.location.pathname !== "/") window.history.back();
      else CapApp.minimizeApp();
    });
    return () => { handle.then((h) => h.remove()); };
  }, []);

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

  if (!onboarded) return <Onboarding onDone={() => { setOnboarded(true); setSignedIn(isSignedIn()); }} />;
  if (!signedIn) return <AccountGate onDone={() => setSignedIn(true)} />;

  return (
    <div className="app">
      <Header />
      <ScrollMemory />
      <Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 120 }} /></div>}>
        <Routes>
          <Route path="/" element={<Capture />} />
          <Route path="/meeting" element={<Meeting />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/conversation/:id" element={<ConversationDetail />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/capture" element={<CaptureSettings />} />
          <Route path="/settings/context" element={<ContextSettings />} />
          <Route path="/settings/projects" element={<ProjectsHub />} />
          <Route path="/settings/projects/:id" element={<ProjectDetail />} />
          <Route path="/settings/people" element={<PeopleSettings />} />
          <Route path="/settings/account" element={<AccountSettings />} />
          <Route path="/settings/connections" element={<ConnectionsSettings />} />
          <Route path="/settings/recap" element={<RecapSettings />} />
          <Route path="/settings/advanced" element={<AdvancedSettings />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/legal/:doc" element={<LegalDoc />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Nav />
    </div>
  );
}
