import { NavLink } from "react-router-dom";
import { Mic, Library, Share2, MessageSquare, Settings as Cog } from "lucide-react";

const items = [
  { to: "/", label: "Capture", icon: Mic },
  { to: "/memory", label: "Memory", icon: Library },
  { to: "/graph", label: "Graph", icon: Share2 },
  { to: "/chat", label: "Ask", icon: MessageSquare },
  { to: "/settings", label: "Settings", icon: Cog },
];

export function Nav() {
  return (
    // NavLink applies aria-current="page" on the active link by default (kept explicit here).
    <nav className="nav" aria-label="Primary">
      {items.map(({ to, label, icon: Icon }) => (
        // react-router's NavLink sets aria-current="page" on the active anchor automatically.
        <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
          <Icon size={21} strokeWidth={2} aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
