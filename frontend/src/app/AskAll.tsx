import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { api } from "../local/sutra";
import { shortDate } from "./format";
import { friendlyError } from "./ui";

interface Turn { q: string; a?: string; supported?: boolean; citations?: { conversation_id: number; title: string; date: string | null }[] }

/** "Ask Sutra" across every meeting — grounded answers with links back to the meetings they came from. */
export function AskAll() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const initial = params.get("q") ?? "";
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");

  const ask = async (question: string) => {
    question = question.trim();
    if (!question) return;
    const history = turns.flatMap((t) => (t.a ? [{ role: "user", content: t.q }, { role: "assistant", content: t.a }] : []));
    setTurns((xs) => [...xs, { q: question }]);
    let res: Turn;
    try {
      const r: any = await api.chat(question, history);
      res = { q: question, a: r.answer, supported: r.supported, citations: r.citations };
    } catch (e) { res = { q: question, a: friendlyError(e), supported: false }; }
    setTurns((xs) => xs.map((x) => (x.q === question && !x.a ? res : x)));
  };

  useEffect(() => {
    if (initial) { setTurns([]); void ask(initial); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  return (
    <>
      <div className="pane-top drag">
        <button className="icon-btn ghost sm back-btn" onClick={() => nav("/")} aria-label="Back"><ArrowLeft size={18} /></button>
      </div>
      <div className="scroll">
        <div className="doc">
          <h1 className="m-title" style={{ display: "flex", alignItems: "center", gap: 10 }}><Sparkles size={24} /> Ask Sutra</h1>
          <p className="m-sub">Answers come only from your own meetings, with links to where they were said.</p>
          {turns.map((t, i) => (
            <section key={i} className="sec">
              <h3 style={{ marginTop: 0 }}>{t.q}</h3>
              {t.a === undefined ? <p className="muted"><Loader2 size={14} className="spin" /> Searching your meetings…</p> : <p style={{ whiteSpace: "pre-wrap" }}>{t.a}</p>}
              {!!t.citations?.length && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  {t.citations.map((c) => (
                    <Link key={c.conversation_id} className="tag" style={{ textDecoration: "none", paddingRight: 10 }} to={`/m/${c.conversation_id}`}>
                      {c.title}{c.date ? ` · ${shortDate(c.date)}` : ""}
                    </Link>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
      <div className="pane-fade" />
      <div className="askbar">
        <form className="ask-input" onSubmit={(e) => { e.preventDefault(); const v = q; setQ(""); if (!turns.length) setParams({ q: v }); else void ask(v); }}>
          <Sparkles size={17} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about your meetings…" aria-label="Ask Sutra" autoFocus={!initial} />
        </form>
      </div>
    </>
  );
}
