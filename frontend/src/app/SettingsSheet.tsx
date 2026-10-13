import { useEffect, useState, type ComponentType } from "react";
import { ArrowLeft, Archive, Bell, Brain, ChevronRight, Plug, Settings2, SlidersHorizontal, Sparkles, UserRound, Users, X } from "lucide-react";
import { api } from "../local/sutra";
import { desktop } from "../desktop/bridge";
import { useToast } from "./ui";
import { Intelligence } from "./Intelligence";
import { useMedia, type SectionProps } from "./settings/kit";
import { GeneralSection } from "./settings/GeneralSection";
import { PeopleSection } from "./settings/PeopleSection";
import { ContextSection } from "./settings/ContextSection";
import { ConnectionsSection } from "./settings/ConnectionsSection";
import { BackupSection } from "./settings/BackupSection";
import { RecapSection } from "./settings/RecapSection";
import { AdvancedSection } from "./settings/AdvancedSection";
import { AccountSection } from "./settings/AccountSection";
import "./settings/settings.css";

function IntelligenceSection({ settings, put }: SectionProps) {
  return <Intelligence settings={settings} onChange={(p) => put({ ...p, setup_engines: true })} />;
}

type SectionId = "general" | "intelligence" | "people" | "context" | "connections" | "backup" | "recap" | "advanced" | "account";
const SECTIONS: { id: SectionId; label: string; icon: ComponentType<{ size?: number }>; view: ComponentType<SectionProps> }[] = [
  { id: "general", label: "General", icon: Settings2, view: GeneralSection },
  { id: "intelligence", label: "Intelligence", icon: Sparkles, view: IntelligenceSection },
  { id: "people", label: "People", icon: Users, view: PeopleSection },
  { id: "context", label: "Your context", icon: Brain, view: ContextSection },
  { id: "connections", label: "Connections", icon: Plug, view: ConnectionsSection },
  { id: "backup", label: "Backup & restore", icon: Archive, view: BackupSection },
  { id: "recap", label: "Daily recap", icon: Bell, view: RecapSection },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal, view: AdvancedSection },
  // Accounts, cloud sync and plans are phone/web only; the desktop app works without an account.
  ...(desktop ? [] : [{ id: "account" as const, label: "Account", icon: UserRound, view: AccountSection }]),
];

// Remember the last section while the app runs, so reopening Settings lands where you were.
let lastSection: SectionId = "general";

/** Everything configurable, in one calm sheet: a quiet section list on the left (wide) or a list ⇄
 *  section flow (phone). Pipeline settings live in the on-device DB; desktop-only detection prefs
 *  live in the main process (so detection works before any window has loaded). */
export function SettingsSheet({ onClose, initialSection }: { onClose: () => void; initialSection?: SectionId }) {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const narrow = useMedia("(max-width: 820px)");
  const [section, setSection] = useState<SectionId>(() => initialSection ?? lastSection);
  // Phone: start on the list unless a section was asked for.
  const [showList, setShowList] = useState(!initialSection);
  const [toast, showToast] = useToast();

  useEffect(() => { void api.getSettings().then(setSettings); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".settings-sheet .menu")) return; // Esc closes the open row menu first
      if (narrow && !showList) setShowList(true);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, narrow, showList]);

  const put = async (patch: Record<string, unknown>) => { setSettings(await api.putSettings(patch)); };
  const open = (id: SectionId) => { lastSection = id; setSection(id); setShowList(false); };

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const View = current.view;
  const listing = narrow && showList;
  const body = settings && <View settings={settings} put={put} toast={showToast} />;

  return (
    <div className="overlay settings-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet settings-sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className={`sheet-head${narrow && !listing ? " with-back" : ""}`}>
          {narrow && !listing && <button className="icon-btn ghost sm" onClick={() => setShowList(true)} aria-label="All settings"><ArrowLeft size={18} /></button>}
          <h2>{narrow && !listing ? current.label : "Settings"}</h2>
          <button className="icon-btn ghost sm" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {narrow ? (
          <div className="set-body">
            <div className="set-content" style={{ paddingTop: 0 }}>
              {listing ? (
                <div className="set-card set-nav-card" style={{ margin: "4px 0 0" }}>
                  {SECTIONS.map((s) => (
                    <button key={s.id} className="set-row" onClick={() => open(s.id)}>
                      <s.icon size={17} />
                      <div className="grow"><div className="t">{s.label}</div></div>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              ) : body}
            </div>
          </div>
        ) : (
          <div className="set-body">
            <nav className="set-nav" aria-label="Settings sections">
              {SECTIONS.map((s) => (
                <button key={s.id} aria-current={s.id === section ? "page" : undefined} onClick={() => open(s.id)}>
                  <s.icon size={16} />{s.label}
                </button>
              ))}
            </nav>
            <div className="set-content" key={section}>{body}</div>
          </div>
        )}
      </div>
      {toast}
    </div>
  );
}
