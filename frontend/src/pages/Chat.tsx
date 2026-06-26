import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Send, Sparkles, AlertTriangle } from "lucide-react";
import { api } from "../local/sutra";
import { Chip, ErrorBar } from "../components/ui";
import { tapHaptic } from "../lib/nativeChrome";

interface Msg { id: number; role: "user" | "assistant"; content: string; citations?: any[]; supported?: boolean }

let nextMsgId = 0;
const newMsg = (m: Omit<Msg, "id">): Msg => ({ id: nextMsgId++, ...m });

// Keep the Ask thread alive across route changes — module scope survives navigation (no sessionStorage;
// losing it on a full app restart is acceptable). Capped so it can't grow unbounded.
let chatCache: Msg[] = [];

export default function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>(() => chatCache);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Depend on messages only — the busy toggle was causing a second smooth-scroll (jank).
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);
  // Persist the thread to module scope so it's restored when you come back to Ask (last 50 only).
  useEffect(() => { chatCache = msgs.slice(-50); }, [msgs]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setKeyboardInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 122)}px`;
  }, [input]);

  const sendMessage = async () => {
    const text = input.trim(); if (!text || busy) return;
    void tapHaptic();
    setInput(""); setError(null);
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((p) => [...p, newMsg({ role: "user", content: text })]);
    setBusy(true);
    try {
      const r = await api.chat(text, history);
      setMsgs((p) => [...p, newMsg({ role: "assistant", content: r.answer, citations: r.citations, supported: r.supported })]);
    } catch (e: any) { setError(e.message); setInput(text); }
    finally { setBusy(false); }
  };

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessage();
  };

  return (
    <div className="page fade-in chat-page focus-page">
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <div className="chat-scroll">
        {msgs.length === 0 && (
          <div className="empty chat-empty"><Sparkles size={34} className="chat-spark" />
            <div style={{ color: "var(--muted)" }}>Ask anything about your conversations.</div>
            <div className="faint" style={{ fontSize: "var(--fs-s)", maxWidth: 320, marginInline: "auto", marginTop: 6 }}>Answers grounded in your memory, with citations. It won't invent what it doesn't know.</div>
            <div className="stack" style={{ marginTop: 18, maxWidth: 320, marginInline: "auto" }}>
              {["What did we decide in the last meeting?", "What's still open from yesterday's stand-up?", "Who is working on what?"].map((s, i) => (
                <button key={s} className="btn ghost sm stagger-rise chat-suggest" style={{ "--i": i } as React.CSSProperties} onClick={() => { setInput(s); inputRef.current?.focus(); }}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          // chat-turn: rise+fade entrance keyed on the stable msg id, so streaming re-renders of the
          // SAME assistant message don't restart it. Assistant bubble unfolds from its top-left edge.
          <div key={m.id} className={`turn chat-turn ${m.role === "user" ? "me" : ""}`}>
            <div className="who">{m.role === "user" ? "You" : "Sutra"}{m.role === "assistant" && m.supported === false && <Chip kind="warn"><AlertTriangle size={11} /> no record</Chip>}</div>
            <div className="bubble" style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
            {m.citations && m.citations.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {m.citations.map((c: any) => (
                  <Link key={c.conversation_id} to={`/conversation/${c.conversation_id}`} className="cite"
                    style={{ display: "inline-flex", alignItems: "baseline", gap: 5, maxWidth: "100%", minWidth: 0 }}>
                    <span className="trunc">{c.title || "source"}</span>
                    {c.date && <span style={{ flexShrink: 0, opacity: 0.8 }}>· {c.date}</span>}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="turn"><div className="who">Sutra</div><div className="bubble"><span className="spinner" /></div></div>}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="chat-composer" style={{ "--keyboard-inset": `${keyboardInset}px` } as React.CSSProperties}>
        <textarea
          ref={inputRef}
          className="input chat-input"
          placeholder="Ask your memory..."
          aria-label="Ask your memory"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendMessage();
            }
          }}
        />
        <button className="btn primary chat-send" aria-label="Send" disabled={busy || !input.trim()}><Send size={17} /></button>
      </form>
    </div>
  );
}
