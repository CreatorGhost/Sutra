import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { LocateFixed, Share2, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../local/sutra";
import { Chip, Empty, SkeletonList, isBenignError, typeColor } from "./ui";
import { tapHaptic } from "../lib/nativeChrome";

/** Self-contained entity graph (canvas + legend + selected-node card + entities list).
 *  Lives in a component so it can be mounted both as the Memory "graph" tab and the
 *  standalone GraphPage route. Takes no props — it owns all its own state. */
export default function GraphView() {
  const [data, setData] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<any>(null);
  const [dims, setDims] = useState({ w: 360, h: 460 });
  const wrap = useRef<HTMLDivElement>(null);
  const fg = useRef<any>(null);

  const load = () => { setError(null); api.graph().then(setData).catch((e) => setError(e.message)); };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(() => {
      const el = wrap.current!; setDims({ w: el.clientWidth, h: Math.max(420, Math.min(560, window.innerHeight * 0.6)) });
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [data]);

  const graph = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    return {
      nodes: data.nodes.map((n) => ({ id: n.id, name: n.canonical_name, type: n.type, val: 1 + (n.mention_count || 1) })),
      links: data.edges.map((e) => ({ source: e.src, target: e.dst, relation: e.relation })),
    };
  }, [data]);
  const graphNodes = graph.nodes as any[];

  const expand = async (id: number) => {
    try {
      const sub = await api.graph(id, 2);
      setData((prev) => {
        if (!prev) return sub;
        const nIds = new Set(prev.nodes.map((n) => n.id));
        const eIds = new Set(prev.edges.map((e) => e.id));
        return {
          nodes: [...prev.nodes, ...sub.nodes.filter((n: any) => !nIds.has(n.id))],
          edges: [...prev.edges, ...sub.edges.filter((e: any) => !eIds.has(e.id))],
        };
      });
    } catch (e: any) { setError(e.message); }
  };

  const selectNode = (n: any) => {
    void tapHaptic();
    setSel(n);
    void expand(Number(n.id));
  };

  const zoomBy = (factor: number) => {
    const current = fg.current?.zoom?.();
    if (typeof current === "number") fg.current.zoom(current * factor, 240);
  };

  // The graph is a single section, so a load failure degrades inline (with retry) rather than
  // painting the global banner. Benign engine limits (web FTS5) read as an empty graph.
  if (error) {
    return isBenignError(error) ? (
      <Empty icon={<Share2 size={36} />} title="The graph isn't available here" hint="Entity links open on the device build." />
    ) : (
      <div className="empty"><Share2 size={36} /><div style={{ color: "var(--muted)", marginBottom: 12 }}>Couldn't load the graph</div><button className="btn sm" onClick={load}>Try again</button></div>
    );
  }
  if (!data) return <SkeletonList rows={4} />;
  if (data.nodes.length === 0) return <Empty icon={<Share2 size={36} />} title="The graph is empty" hint="Process a conversation to populate entities and links." />;

  return (
    <>
      <div className="graph-controls" aria-label="Graph controls">
        <button className="icon-btn" aria-label="Fit graph" title="Fit graph" onClick={() => fg.current?.zoomToFit?.(400, 42)}><LocateFixed size={18} /></button>
        <button className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.24)}><ZoomIn size={18} /></button>
        <button className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(0.8)}><ZoomOut size={18} /></button>
      </div>
      <p className="faint" style={{ fontSize: "var(--fs-xs)", margin: "-2px 2px 10px" }}>Tap a node to expand.</p>
      <div ref={wrap} className="card graph-canvas" aria-hidden="true" style={{ padding: 0, overflow: "hidden", height: dims.h }}>
        {data && (
          <ForceGraph2D
            ref={fg}
            width={dims.w}
            height={dims.h}
            graphData={graph as any}
            backgroundColor="rgba(0,0,0,0)"
            linkColor={() => "rgba(150,150,170,0.22)"}
            linkDirectionalParticles={0}
            cooldownTicks={80}
            onEngineStop={() => fg.current?.zoomToFit?.(400, 46)}
            nodeRelSize={5}
            onNodeClick={selectNode}
            nodePointerAreaPaint={(node: any, color, ctx) => {
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(node.x, node.y, 18, 0, 2 * Math.PI, false);
              ctx.fill();
            }}
            nodeCanvasObject={(node: any, ctx, scale) => {
              const r = 3 + Math.sqrt(node.val) * 1.6;
              ctx.beginPath();
              ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
              ctx.fillStyle = typeColor(node.type);
              ctx.fill();
              if (scale > 1.4) {
                ctx.font = `${11 / scale}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
                ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text") || "rgba(236,235,240,0.85)";
                ctx.fillText(node.name, node.x + r + 1.5, node.y + 3 / scale);
              }
            }}
          />
        )}
      </div>
      <ul className="graph-legend" aria-label="Entity type legend">
        {["person", "project", "topic", "org", "place", "event", "commitment"].map((t) => (
          <li key={t} className="chip tag-type"><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: typeColor(t), display: "inline-block" }} /> {t}</li>
        ))}
      </ul>
      {sel && (
        <div className="card fade-in" style={{ marginTop: 14 }}>
          <div className="between"><strong>{sel.name}</strong><Chip>{sel.type}</Chip></div>
          <div className="muted" style={{ fontSize: "var(--fs-s)", marginTop: 6 }}>{sel.val - 1} mention{sel.val - 1 === 1 ? "" : "s"}. Connected nodes are shown above.</div>
        </div>
      )}
      <section className="graph-list" aria-labelledby="graph-list-title">
        <div className="between" style={{ margin: "18px 2px 10px" }}>
          <h2 id="graph-list-title" className="section-h" style={{ margin: 0 }}>Entities</h2>
          <Chip>{graphNodes.length}</Chip>
        </div>
        <div className="settings-group-body">
          {graphNodes.slice(0, 80).map((n: any) => {
            const mentions = Math.max(0, n.val - 1);
            const active = sel?.id === n.id;
            return (
              <button key={n.id} className={`settings-row graph-row ${active ? "active" : ""}`} onClick={() => selectNode(n)} aria-pressed={active}>
                <span className="type-dot" style={{ background: typeColor(n.type) }} aria-hidden="true" />
                <span className="settings-row-main">
                  <strong>{n.name}</strong>
                  <small>{n.type} · {mentions} mention{mentions === 1 ? "" : "s"}</small>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}
