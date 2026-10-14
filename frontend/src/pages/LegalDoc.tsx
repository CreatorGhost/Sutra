import { useEffect, useState, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import "./legal.css";

// The bundled DRAFT legal docs (docs/legal → public/legal). Fetched at runtime so the markdown stays
// the single source. NOTE: these are drafts with [BRACKET] placeholders until finalized + lawyer-reviewed.
const DOCS: Record<string, { title: string; file: string }> = {
  privacy: { title: "Privacy Policy", file: "legal/privacy.md" },
  terms: { title: "Terms of Service", file: "legal/terms.md" },
};

// Inline bold (**...**) → <strong>. Everything else passes through as text.
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>,
  );
}

// Minimal line-based markdown → elements (headings, blockquote, bullets, rule, paragraphs). Enough for
// the legal docs and needs no renderer dependency. ponytail: not a general parser — extend if a doc needs it.
function render(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  let para: string[] = [];
  const flush = (k: string) => { if (para.length) { out.push(<p key={k}>{inline(para.join(" "))}</p>); para = []; } };
  md.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return flush(`p${i}`);
    if (line.startsWith("### ")) { flush(`f${i}`); out.push(<h3 key={i}>{inline(line.slice(4))}</h3>); }
    else if (line.startsWith("## ")) { flush(`f${i}`); out.push(<h2 key={i}>{inline(line.slice(3))}</h2>); }
    else if (line.startsWith("# ")) { flush(`f${i}`); out.push(<h1 key={i}>{inline(line.slice(2))}</h1>); }
    else if (line.startsWith("> ")) { flush(`f${i}`); out.push(<blockquote key={i}>{inline(line.slice(2))}</blockquote>); }
    else if (/^[-*] /.test(line)) { flush(`f${i}`); out.push(<p key={i} className="bullet">• {inline(line.slice(2))}</p>); }
    else if (line === "---") { flush(`f${i}`); out.push(<hr key={i} />); }
    else para.push(line);
  });
  flush("end");
  return out;
}

export default function LegalDoc() {
  const { doc } = useParams();
  const navigate = useNavigate();
  const meta = doc ? DOCS[doc] : undefined;
  const [md, setMd] = useState("");
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!meta) return;
    let alive = true;
    fetch(meta.file)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => alive && setMd(t))
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [meta?.file]);

  return (
    <div className="page fade-in legal-doc">
      <button className="legal-back" onClick={() => navigate(-1)}><ChevronLeft size={16} /> Back</button>
      {!meta ? <p className="faint">Unknown document.</p>
        : err ? <p className="faint">Couldn’t load the {meta.title}. Please try again.</p>
        : md ? render(md)
        : <p className="faint">Loading…</p>}
    </div>
  );
}
