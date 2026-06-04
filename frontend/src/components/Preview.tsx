import { HomeView, type HomeData } from "./HomeView";

const SWATCHES: [string, string][] = [
  ["bg", "#0a0912"], ["surface", "#14121e"], ["surface-2", "#1b1830"], ["surface-3", "#241f3a"],
  ["border", "#272340"], ["text", "#f1eff8"], ["text-2", "#bcb7cd"], ["muted", "#8c879f"],
  ["accent", "#8b7bff"], ["accent-2", "#a99bff"], ["accent-deep", "#6f5cf0"],
  ["amber", "#ffb23e"], ["amber-2", "#ffc873"], ["ok", "#3ddc97"], ["danger", "#ff5d73"],
];

function Swatches() {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "8px 20px 40px" }}>
      <div className="greet" style={{ marginBottom: 4 }}>Sutra <span className="accent">design tokens</span></div>
      <div className="page-sub">Indigo/violet = AI &amp; memory · warm amber = scheduled / reminders · dark default.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(118px,1fr))", gap: 10 }}>
        {SWATCHES.map(([n, hex]) => (
          <div key={n} className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ height: 52, background: hex }} />
            <div style={{ padding: "8px 10px" }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{n}</div>
              <div className="mono faint" style={{ fontSize: 11 }}>{hex}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const mock: HomeData = {
  name: "Aditya", mode: "ondevice", recording: true, elapsed: "02:40", level: 0.62, memoryCount: 6,
  latest: {
    meta: "30 MAY • 10:30 AM • 10 MIN",
    title: "College application shortlist & Friday SOP review",
    desc: "Amartya shortlisted BITS Pilani, IIT Bombay and Ashoka; SOP review booked for Friday 5pm at the library.",
    chips: [{ label: "3 actions", kind: "amber" }, { label: "decision", kind: "accent" }], lang: "hi-en",
  },
  comingUp: [{ title: "Design Standup", when: "11 Sep • 10:30 – 11:00 AM" }, { title: "Call landlord re: rent", when: "Mon • reminder" }],
};

export function Preview() {
  return (
    <div className="app">
      <HomeView data={mock} />
      <Swatches />
    </div>
  );
}
