import GraphView from "../components/GraphView";

export default function GraphPage() {
  return (
    <div className="page fade-in wide-page graph-page" style={{ paddingBottom: "calc(var(--nav-h) + var(--sab) + 8px)" }}>
      <GraphView />
    </div>
  );
}
