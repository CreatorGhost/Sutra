import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Share2 } from "lucide-react";
import { useHeaderTitle, useHeaderAction, useHeaderStatus, titleForPath } from "../lib/headerTitle";
import { PROJECT_LABEL } from "../local/repo";

// Runtime label only the repo layer knows; injected into the shared static-title resolver so
// headerTitle.ts stays repo-free. The /meeting title (ticket F7) lives in headerTitle's STATIC_TITLES.
const TITLE_OVERRIDES: Record<string, string> = { "/settings/projects": PROJECT_LABEL };

/** Top app bar — the single source of truth for the screen title (pages no longer repeat it as an H1). */
export function Header() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const dynamic = useHeaderTitle(); // detail pages publish their real loaded title here
  const action = useHeaderAction(); // active page may publish a trailing Share action
  const status = useHeaderStatus(); // Capture publishes live recording status while on "/"
  // Project detail (/settings/projects/:id) publishes its loaded name as the dynamic title, like conversations.
  const isProjectDetail = /^\/settings\/projects\/[^/]+$/.test(pathname);
  const title = pathname.startsWith("/conversation")
    ? (dynamic ?? "Conversation")
    : isProjectDetail
      ? (dynamic ?? PROJECT_LABEL)
      : titleForPath(pathname, TITLE_OVERRIDES);

  // Back button on detail/sub routes; navigate(-1) with a sensible parent fallback.
  const isConversation = pathname.startsWith("/conversation/");
  const isSettingsSub = pathname.startsWith("/settings/");
  const isSignIn = pathname === "/signin";
  const showBack = isConversation || isSettingsSub || isSignIn;
  const goBack = () => {
    if (window.history.length > 1) { navigate(-1); return; }
    navigate(isConversation ? "/memory" : isSignIn ? "/settings/connections" : "/settings");
  };

  return (
    <header className="app-header">
      {showBack && (
        <button className="icon-btn hdr-btn" onClick={goBack} aria-label="Back"><ArrowLeft size={18} /></button>
      )}
      {status && pathname === "/" ? (
        <span className="hdr-status">
          <span className={`status-dot ${status.kind === "rec" ? "live" : status.kind === "proc" ? "proc" : "idle"}`} />
          <span className="mono">{status.text}</span>
        </span>
      ) : (
        // Drilled-in views (back button) get a left-aligned, truncating title and no brand dot;
        // the dot is reserved for top-level screens. The drilled title flexes to fill the bar,
        // so the trailing spacer is only needed on top-level screens.
        <h1 className={`brand${showBack ? " drilled" : ""}`}>{pathname === "/" && <span className="dot" />}{title}</h1>
      )}
      {!showBack && <span className="spacer" />}
      {action && (
        <button className="icon-btn hdr-btn" onClick={action.onTap} aria-label={action.label}><Share2 size={18} /></button>
      )}
    </header>
  );
}
