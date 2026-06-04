import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { Share2 } from "lucide-react";
import { api } from "../local/sutra";
import { Chip, Empty, isBenignError, typeColor } from "../components/ui";

export default function GraphPage() {
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

  return (
    <div className="page fade-in" style={{ paddingBottom: "calc(var(--nav-h) + var(--sab) + 8px)" }}>
      <p className="page-sub">People, projects and topics linked across your conversations. Tap a node to expand.</p>

      {/* The graph is a single section, so a load failure degrades inline (with retry) rather than
          painting the global banner. Benign engine limits (web FTS5) read as an empty graph. */}
      {error ? (
        isBenignError(error) ? (
          <Empty icon={<Share2 size={36} />} title="The graph isn't available here" hint="Entity links open on the device build." />
        ) : (
          <div className="empty"><Share2 size={36} /><div style={{ color: "var(--muted)", marginBottom: 12 }}>Couldn't load the graph</div><button className="btn sm" onClick={load}>Try again</button></div>
        )
      ) : !data ? (
        <div className="skeleton" style={{ height: 460 }} />
      ) : data.nodes.length === 0 ? (
        <Empty icon={<Share2 size={36} />} title="The graph is empty" hint="Process a conversation to populate entities and links." />
      ) : (
        <>
          <div ref={wrap} className="card" style={{ padding: 0, overflow: "hidden", height: dims.h }}>
            {data && (
              <ForceGraph2D
                ref={fg}
                width={dims.w}
                height={dims.h}
                graphData={graph as any}
                backgroundColor="#0e0e14"
                linkColor={() => "rgba(150,150,170,0.22)"}
                linkDirectionalParticles={0}
                cooldownTicks={80}
                nodeRelSize={5}
                onNodeClick={(n: any) => { setSel(n); expand(n.id); }}
                nodeCanvasObject={(node: any, ctx, scale) => {
                  const r = 3 + Math.sqrt(node.val) * 1.6;
                  ctx.beginPath();
                  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
                  ctx.fillStyle = typeColor(node.type);
                  ctx.fill();
                  if (scale > 1.4) {
                    ctx.font = `${11 / scale}px Inter, sans-serif`;
                    ctx.fillStyle = "rgba(236,235,240,0.85)";
                    ctx.fillText(node.name, node.x + r + 1.5, node.y + 3 / scale);
                  }
                }}
              />
            )}
          </div>
          <div className="row" style={{ gap: 7, flexWrap: "wrap", marginTop: 12 }}>
            {["person", "project", "topic", "org", "place", "event", "commitment"].map((t) => (
              <span key={t} className="chip tag-type"><span style={{ width: 8, height: 8, borderRadius: "50%", background: typeColor(t), display: "inline-block" }} /> {t}</span>
            ))}
          </div>
          {sel && (
            <div className="card fade-in" style={{ marginTop: 14 }}>
              <div className="between"><strong>{sel.name}</strong><Chip>{sel.type}</Chip></div>
              <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{sel.val - 1} mention{sel.val - 1 === 1 ? "" : "s"}. Connected nodes are shown above.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
