import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Send, Sparkles, AlertTriangle } from "lucide-react";
import { api } from "../local/sutra";
import { Chip, ErrorBar } from "../components/ui";

interface Msg { id: number; role: "user" | "assistant"; content: string; citations?: any[]; supported?: boolean }

let nextMsgId = 0;
const newMsg = (m: Omit<Msg, "id">): Msg => ({ id: nextMsgId++, ...m });

export default function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Depend on messages only — the busy toggle was causing a second smooth-scroll (jank).
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim(); if (!text || busy) return;
    setInput(""); setError(null);
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((p) => [...p, newMsg({ role: "user", content: text })]);
    setBusy(true);
    try {
      const r = await api.chat(text, history);
      setMsgs((p) => [...p, newMsg({ role: "assistant", content: r.answer, citations: r.citations, supported: r.supported })]);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="page fade-in chat-page">
      <p className="page-sub" style={{ marginBottom: 12 }}>Answers grounded in your memory, with citations. It won't invent what it doesn't know.</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <div className="chat-scroll">
        {msgs.length === 0 && (
          <div className="empty"><Sparkles size={34} /><div style={{ color: "var(--muted)" }}>Ask anything about your conversations.</div>
            <div className="stack" style={{ marginTop: 18, maxWidth: 320, marginInline: "auto" }}>
              {["What did we decide about the project?", "What are my open commitments?", "Who did I talk to about college?"].map((s) => (
                <button key={s} className="btn ghost sm" onClick={() => setInput(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`turn ${m.role === "user" ? "me" : ""}`}>
            <div className="who">{m.role === "user" ? "You" : "Sutra"}{m.role === "assistant" && m.supported === false && <Chip kind="warn"><AlertTriangle size={11} /> no record</Chip>}</div>
            <div className="bubble" style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
            {m.citations && m.citations.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {m.citations.map((c: any) => (
                  <Link key={c.conversation_id} to={`/conversation/${c.conversation_id}`} className="cite">{c.title || "source"} · {c.date}</Link>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="turn"><div className="who">Sutra</div><div className="bubble"><span className="spinner" /></div></div>}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="chat-composer">
        <input className="input" placeholder="Ask your memory…" aria-label="Ask your memory" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn primary" aria-label="Send" disabled={busy || !input.trim()}><Send size={17} /></button>
      </form>
    </div>
  );
}
