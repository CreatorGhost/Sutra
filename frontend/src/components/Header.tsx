import { useLocation } from "react-router-dom";
import { useHeaderTitle } from "../lib/headerTitle";

const TITLES: Record<string, string> = {
  "/": "Sutra", "/memory": "Memory", "/graph": "Graph", "/chat": "Ask Sutra", "/settings": "Settings",
};

/** Top app bar — the single source of truth for the screen title (pages no longer repeat it as an H1). */
export function Header() {
  const { pathname } = useLocation();
  const dynamic = useHeaderTitle(); // detail pages publish their real loaded title here
  const title = pathname.startsWith("/conversation")
    ? (dynamic ?? "Conversation")
    : (TITLES[pathname] ?? "Sutra");
  return (
    <header className="app-header">
      <span className="brand"><span className="dot" />{title}</span>
      <span className="spacer" />
    </header>
  );
}
