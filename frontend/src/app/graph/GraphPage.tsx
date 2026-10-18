import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ForceGraph2D from "react-force-graph-2d";
import { ArrowLeft, LocateFixed, Search, Waypoints, X, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../../local/sutra";
import { useDataVersion } from "../events";
import { shortDate } from "../format";
import { Popover, friendlyError } from "../ui";
import { buildGraph, mergeGraph, relationLabel, searchNodes, typeCounts, typeKey, type EntityType, type GNode, type RawGraph } from "./model";
import "../features.css";

/** Canvas colours come from the CSS tokens so the graph follows dark / light. */
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
  return {
    text: v("--text", "#f3f3f5"), text3: v("--text-3", "#6c6c74"), line: v("--line-2", "rgba(255,255,255,.12)"),
    panel: v("--panel", "#111113"), accent: v("--accent", "#4f7cff"),
    type: (t: EntityType) => v(`--t-${t}`, "#8a8a93"),
  };
}
type Theme = ReturnType<typeof readTheme>;

function useThemeTokens(): Theme {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/** The knowledge graph: who and what comes up across meetings, and how they connect. */
export function GraphPage() {
  const nav = useNavigate();
  const version = useDataVersion();
  const theme = useThemeTokens();
  const [data, setData] = useState<RawGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<EntityType>>(new Set());
  const [selId, setSelId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const stage = useRef<HTMLDivElement | null>(null);
  const fg = useRef<any>(null);

  useEffect(() => {
    let alive = true;
    api.graph().then((g: any) => { if (alive) { setData(g); setError(null); } }).catch((e) => { if (alive) setError(friendlyError(e)); });
    return () => { alive = false; };
  }, [version]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  // Keep node objects stable across renders: the simulation mutates x/y on them.
  const nodeCache = useRef(new Map<number, any>());
  const graph = useMemo(() => {
    const g = buildGraph(data, hidden);
    const nodes = g.nodes.map((n) => Object.assign(nodeCache.current.get(n.id) ?? {}, n));
    nodes.forEach((n) => nodeCache.current.set(n.id, n));
    return { nodes, links: g.links };
  }, [data, hidden]);
  const counts = useMemo(() => typeCounts(data), [data]);
  const neighbours = useMemo(() => {
    const s = new Set<number>();
    if (selId == null) return s;
    for (const l of graph.links as any[]) {
      const a = typeof l.source === "object" ? l.source.id : l.source, b = typeof l.target === "object" ? l.target.id : l.target;
      if (a === selId) s.add(b); if (b === selId) s.add(a);
    }
    return s;
  }, [graph, selId]);

  // Selecting pulls in that entity's neighbourhood so its links are drawn, then centres on it.
  const select = useCallback(async (id: number) => {
    setSelId(id);
    try { const sub = await api.graph(id, 1); setData((prev) => mergeGraph(prev, sub as any)); } catch { /* keep what's drawn */ }
    setTimeout(() => {
      const n = nodeCache.current.get(id);
      if (n?.x == null || !fg.current) return;
      // Centre the node in the part of the canvas the side card (bottom sheet on phones) leaves visible.
      const z = Math.max(fg.current.zoom() ?? 1, 2.2);
      const el = stage.current;
      const phone = (el?.clientWidth ?? 1000) <= 820 && window.innerWidth <= 820;
      const dx = phone ? 0 : 170 / z, dy = phone ? ((el?.clientHeight ?? 600) * 0.28) / z : 0;
      fg.current.centerAt(n.x + dx, n.y + dy, 500);
      fg.current.zoom(z, 500);
    }, 350);
  }, []);

  // Fit everything, but never blow a small graph up into giant dots.
  const fit = () => {
    fg.current?.zoomToFit?.(400, 80);
    setTimeout(() => { if ((fg.current?.zoom?.() ?? 0) > 2.4) fg.current.zoom(2.4, 300); }, 420);
  };
  const zoomBy = (f: number) => { const z = fg.current?.zoom?.(); if (typeof z === "number") fg.current.zoom(z * f, 240); };
  const matches = useMemo(() => searchNodes(graph.nodes as GNode[], query), [graph, query]);

  // Layout forces (the defaults leave a hairball): repulsion with a reach limit so far clusters don't
  // fling apart, short links, no overlapping dots, and a weak pull to the centre for loose groups.
  useEffect(() => {
    const f = fg.current;
    if (!f?.d3Force) return;
    f.d3Force("charge")?.strength(-90).distanceMax(320);
    f.d3Force("link")?.distance(42);
    f.d3Force("collide", collide((n: any) => nodeRadius(n) + 3));
    f.d3Force("gravity", gravity(0.05));
    f.d3ReheatSimulation?.();
  }, [graph, dims.w > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const top = (
    <div className="pane-top drag graph-top">
      <button className="icon-btn ghost sm back-btn" onClick={() => nav("/")} aria-label="Back"><ArrowLeft size={18} /></button>
      <h1>Graph</h1>
      {!!data?.nodes.length && (
        <Popover open={searchOpen && matches.length > 0} onOpenChange={setSearchOpen} trigger={
          <label className="search">
            <Search size={15} />
            <input value={query} placeholder="Find a person, project, topic…" aria-label="Find in graph"
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
              onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { void select(matches[0].id); setSearchOpen(false); } }} />
            {query && <button className="icon-btn ghost sm" onClick={() => setQuery("")} aria-label="Clear"><X size={14} /></button>}
          </label>
        }>
          {matches.map((n) => (
            <button key={n.id} onClick={() => { void select(n.id); setSearchOpen(false); }}>
              <span className="pdot" style={{ ["--pc" as any]: theme.type(n.type) }} /> {n.name}
              <span className="hint">{n.type}</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );

  if (error || !data || !data.nodes.length) {
    return (
      <>
        {top}
        <div className="center">
          <div>
            <div className="hero-mark"><Waypoints size={24} /></div>
            <p className="hero-title">{error ? "Couldn't load the graph" : data ? "Your graph is empty" : "Loading…"}</p>
            <p className="hero-text">{error ?? "People, projects and topics from your meetings appear here once Sutra has written some notes."}</p>
          </div>
        </div>
      </>
    );
  }

  const label = (n: any) => n.id === selId || neighbours.has(n.id);
  return (
    <>
      {top}
      <div className="graph-stage" ref={stage}>
        <div className="graph-legend" aria-label="Entity types">
          {counts.map(({ type, count }) => (
            <button key={type} className="tag" aria-pressed={!hidden.has(type)}
              onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(type)) n.delete(type); else n.add(type); return n; })}>
              <span className="pdot" style={{ ["--pc" as any]: theme.type(type) }} />{type}<span className="n">{count}</span>
            </button>
          ))}
        </div>
        {dims.w > 0 && (
          <ForceGraph2D
            ref={fg}
            width={dims.w}
            height={dims.h}
            graphData={graph as any}
            backgroundColor="rgba(0,0,0,0)"
            warmupTicks={120}
            cooldownTicks={400}
            onEngineStop={() => { if (selId == null) fit(); }}
            linkLabel={(l: any) => relationLabel(l.relation)}
            linkColor={(l: any) => {
              const a = l.source?.id ?? l.source, b = l.target?.id ?? l.target;
              return selId != null && (a === selId || b === selId) ? theme.text3 : theme.line;
            }}
            linkWidth={(l: any) => ((l.source?.id ?? l.source) === selId || (l.target?.id ?? l.target) === selId ? 1.6 : 1)}
            onNodeClick={(n: any) => void select(n.id)}
            onBackgroundClick={() => setSelId(null)}
            nodePointerAreaPaint={(node: any, color, ctx) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x, node.y, 10, 0, 2 * Math.PI); ctx.fill(); }}
            nodeCanvasObject={(node: any, ctx, scale) => {
              const r = nodeRadius(node);
              const dim = selId != null && !label(node);
              ctx.globalAlpha = dim ? 0.35 : 1;
              ctx.beginPath();
              ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
              ctx.fillStyle = theme.type(node.type);
              ctx.fill();
              if (node.id === selId) { ctx.lineWidth = 2 / scale; ctx.strokeStyle = theme.text; ctx.stroke(); }
              if (label(node) || node.hub || scale > 2.6) {
                ctx.font = `${node.id === selId ? 600 : 500} ${12 / scale}px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif`;
                ctx.fillStyle = dim ? theme.text3 : theme.text;
                ctx.fillText(node.name, node.x + r + 3 / scale, node.y + 4 / scale);
              }
              ctx.globalAlpha = 1;
            }}
          />
        )}
        <div className="graph-zoom">
          <button className="icon-btn" aria-label="Fit" title="Fit" onClick={fit}><LocateFixed size={16} /></button>
          <button className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.3)}><ZoomIn size={16} /></button>
          <button className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(0.77)}><ZoomOut size={16} /></button>
        </div>
        {selId != null && <EntityCard id={selId} theme={theme} onSelect={(id) => void select(id)} onClose={() => setSelId(null)} />}
      </div>
    </>
  );
}

const nodeRadius = (n: { val: number }) => 3 + Math.sqrt(n.val) * 1.5;

/** Keeps dots from overlapping (d3's forceCollide, without adding d3-force as a dependency). */
function collide(radius: (n: any) => number) {
  let nodes: any[] = [];
  const force = () => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], ra = radius(a);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j], min = ra + radius(b);
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (!d) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = Math.hypot(dx, dy); }
        const push = ((min - d) / d) * 0.5;
        a.x -= dx * push; a.y -= dy * push; b.x += dx * push; b.y += dy * push;
      }
    }
  };
  // ponytail: O(n²) per tick; fine for the ≤400 nodes the overview draws, quadtree if that grows.
  force.initialize = (ns: any[]) => { nodes = ns; };
  return force;
}

/** A weak pull towards the centre, so separate groups and loose pairs stay on screen. */
function gravity(strength: number) {
  let nodes: any[] = [];
  const force = (alpha: number) => { for (const n of nodes) { n.vx -= n.x * strength * alpha; n.vy -= n.y * strength * alpha; } };
  force.initialize = (ns: any[]) => { nodes = ns; };
  return force;
}

function EntityCard({ id, theme, onSelect, onClose }: { id: number; theme: Theme; onSelect: (id: number) => void; onClose: () => void }) {
  const [e, setE] = useState<any | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setE(undefined);
    api.entityDetail(id).then((d) => { if (alive) setE(d); }).catch(() => { if (alive) setE(null); });
    return () => { alive = false; };
  }, [id]);

  return (
    <aside className="graph-card" aria-label="Entity details">
      {e === undefined ? (
        <>{[70, 40, 90, 80].map((w, i) => <div key={i} className="skel" style={{ height: i ? 14 : 22, width: `${w}%`, marginBottom: 12 }} />)}</>
      ) : !e ? (
        <p className="muted">This entity is no longer in your graph.</p>
      ) : (
        <>
          <div className="graph-card-head">
            <h2>{e.canonical_name}</h2>
            <button className="icon-btn ghost sm" onClick={onClose} aria-label="Close"><X size={15} /></button>
          </div>
          <div className="kind">
            <span className="pdot" style={{ ["--pc" as any]: theme.type(typeKey(e.type)) }} /><span style={{ textTransform: "capitalize" }}>{e.type}</span>
            <span className="faint">· {e.mention_count} mention{e.mention_count === 1 ? "" : "s"}</span>
          </div>
          {e.description && <p>{e.description}</p>}
          {e.links.length > 0 && (
            <>
              <h3>Connected</h3>
              {e.links.map((l: any, i: number) => (
                <button key={`${l.id}-${l.relation}-${i}`} className="lrow" onClick={() => onSelect(l.id)}>
                  <span className="pdot" style={{ ["--pc" as any]: theme.type(typeKey(l.type)) }} />
                  <span className="grow">{l.canonical_name}</span>
                  <span className="faint">{relationLabel(l.relation)}</span>
                </button>
              ))}
            </>
          )}
          <h3>Meetings</h3>
          {e.meetings.length === 0 ? <p className="faint" style={{ fontSize: 13.5 }}>Not linked to a meeting yet.</p> : e.meetings.map((m: any) => (
            <Link key={m.id} className="lrow" to={`/m/${m.id}`}>
              <span className="grow">{m.title || "Untitled meeting"}</span>
              <span className="faint">{shortDate(m.started_at)}</span>
            </Link>
          ))}
        </>
      )}
    </aside>
  );
}
