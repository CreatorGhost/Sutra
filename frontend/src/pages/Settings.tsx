import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cloud, Brain, Users, Plug, Mail, SlidersHorizontal, Palette, ChevronRight, UserRound, FolderGit2 } from "lucide-react";
import { api } from "../local/sutra";
import { PROJECT_LABEL } from "../local/repo";
import { cachedEmail } from "../lib/auth";
import { type Mode, LANGS, type Lang } from "../providers";
import { syncNativeChrome } from "../lib/nativeChrome";
import { Section, applyThemeChoice, readThemeChoice, type ThemeChoice } from "../components/settingsKit";
import { displayName } from "./settings/AccountSettings";

// Settings hub — Appearance stays inline; everything else is a navigation row into a focused subpage.
// Each row shows a live caption derived from the current config/mode so the hub reflects real state.
// `raw` (optional) is shown as a muted second caption line — used so the Account row can carry the
// human display name as its title while still surfacing the login handle, never headlining it.
type NavRow = { route: string; title: string; caption: string; icon: any; raw?: string };

export default function Settings() {
  const navigate = useNavigate();
  const [cfg, setCfg] = useState<any>({});
  const [mode, setModeState] = useState<Mode>("hybrid");
  const [theme, setTheme] = useState<ThemeChoice>(readThemeChoice);

  const pickTheme = (choice: ThemeChoice) => {
    setTheme(choice);
    try { localStorage.setItem("sutra_theme", choice); } catch { /* localStorage unavailable */ }
    applyThemeChoice(choice);
    void syncNativeChrome();
  };

  useEffect(() => {
    if (theme !== "system" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const update = () => { applyThemeChoice("system"); void syncNativeChrome(); };
    mql.addEventListener?.("change", update);
    return () => mql.removeEventListener?.("change", update);
  }, [theme]);

  // Live captions only — best-effort. A failing read just leaves the default caption; the hub never
  // shows a full-page error because the real controls (and their errors) live in the subpages.
  useEffect(() => {
    let alive = true;
    Promise.allSettled([api.getSettings(), api.getMode()]).then(([c, md]) => {
      if (!alive) return;
      if (c.status === "fulfilled") setCfg(c.value);
      if (md.status === "fulfilled") setModeState(md.value as Mode);
    });
    return () => { alive = false; };
  }, []);

  const lang = (cfg.transcript_lang as Lang) || "english";
  const acctEmail = cachedEmail() || null;
  const rows: NavRow[] = [
    { route: "/settings/account", title: displayName(acctEmail), icon: <UserRound size={16} color="var(--accent-2)" />, caption: "Account · plan & usage", raw: acctEmail ?? undefined },
    { route: "/settings/capture", title: "Capture & language", icon: <Cloud size={16} color="var(--accent-2)" />, caption: `${mode === "hybrid" ? "Hybrid" : "On-device"} · ${LANGS[lang].label}` },
    { route: "/settings/projects", title: PROJECT_LABEL, icon: <FolderGit2 size={16} color="var(--accent-2)" />, caption: "Terms & people, per project" },
    { route: "/settings/context", title: "Your Context", icon: <Brain size={16} color="var(--accent-2)" />, caption: cfg.context_enabled !== false ? "Facts about you · used in Ask" : "Facts about you · off" },
    { route: "/settings/people", title: "People & voices", icon: <Users size={16} color="var(--accent-2)" />, caption: "Speakers Sutra recognizes" },
    { route: "/settings/connections", title: "Connections", icon: <Plug size={16} color="var(--accent-2)" />, caption: [cfg.mcp_enabled && "Local sharing on", cfg.tier_b_enabled && "Cloud sync on"].filter(Boolean).join(" · ") || "Off" },
    { route: "/settings/recap", title: "Daily recap", icon: <Mail size={16} color="var(--accent-2)" />, caption: cfg.recap_enabled ? `Daily at ${cfg.recap_time || "08:00"}` : "Off" },
    { route: "/settings/advanced", title: "Advanced", icon: <SlidersHorizontal size={16} color="var(--warn)" />, caption: "Models, ranking, training, sessions" },
  ];

  return (
    <div className="page fade-in focus-page">
      <Section icon={<Palette size={16} color="var(--accent-2)" />} title="Appearance">
        <div className="pill-toggle" role="radiogroup" aria-label="Appearance" style={{ display: "flex" }}>
          {(["system", "dark", "light"] as ThemeChoice[]).map((t) => (
            <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? "on" : ""}
              style={{ flex: 1, justifyContent: "center", textTransform: "capitalize" }}
              onClick={() => pickTheme(t)}>{t}</button>
          ))}
        </div>
        <div className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 8 }}>System follows your device setting. Dark is the default.</div>
      </Section>

      <div className="settings-group-body">
        {rows.map((r) => (
          <button key={r.route} className="settings-row" onClick={() => navigate(r.route)}>
            {r.icon}
            <span className="settings-row-main">
              <strong>{r.title}</strong>
              {r.raw && <small className="trunc" style={{ display: "block" }}>{r.raw}</small>}
              <small>{r.caption}</small>
            </span>
            <ChevronRight size={16} className="faint" />
          </button>
        ))}
      </div>

      <p className="faint" style={{ textAlign: "center", fontSize: "var(--fs-xs)", marginTop: 12 }}>
        <button onClick={() => navigate("/legal/privacy")} style={{ background: "none", border: 0, color: "var(--accent-2)", cursor: "pointer", font: "inherit", padding: 0 }}>Privacy Policy</button>
        {"  ·  "}
        <button onClick={() => navigate("/legal/terms")} style={{ background: "none", border: 0, color: "var(--accent-2)", cursor: "pointer", font: "inherit", padding: 0 }}>Terms</button>
      </p>
      <p className="faint" style={{ textAlign: "center", fontSize: "var(--fs-xs)", marginTop: 4 }}>Sutra · transcripts & memory only, never audio.</p>
    </div>
  );
}
