// A meeting's chat: questions and answers about this meeting, saved with it (the Chat tab), and what
// the user keeps from it — "Add to notes" puts an answer in the meeting's notes ("Added to this
// meeting", shown on the Notes tab, in exports, and given to the AI as part of the meeting's record),
// next to notes the user writes themselves. Answers render as Markdown; a file path an answer names
// opens in Finder when it's in one of the meeting's project folders.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, MessageSquareText, NotebookPen, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "../../local/sutra";
import type { ChatMessage } from "../../local/repo";
import { desktop } from "../../desktop/bridge";
import { Markdown } from "../Markdown";

/** The meeting's chat, kept in step between the Chat tab, the Notes tab and the Ask bar. */
export function useMeetingChat(cid: number) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const reload = useCallback(async () => { setMessages(await api.meetingChat(cid).catch(() => [])); }, [cid]);
  useEffect(() => { setMessages(null); setPending(null); void reload(); }, [reload]);

  const ask = async (question: string) => {
    setPending(question);
    try { await api.chatMeeting(cid, question); } finally { setPending(null); await reload(); }
  };
  const act = (fn: () => Promise<unknown>) => async () => { await fn(); await reload(); };
  return {
    messages: messages ?? [], loaded: messages !== null, pending, ask, reload,
    pin: (id: number, on: boolean) => act(() => api.setChatPinned(id, on))(),
    edit: (id: number, content: string) => act(() => api.updateChatMessage(id, content))(),
    remove: (id: number) => act(() => api.deleteChatMessage(id))(),
    clear: () => act(() => api.clearMeetingChat(cid))(),
    note: (content: string) => act(() => api.addMeetingNote(cid, content))(),
  };
}
export type MeetingChatState = ReturnType<typeof useMeetingChat>;

/** Show a path an answer mentions ("src/x.ts:29") in Finder, from the meeting's project folders. */
export function pathOpener(folders: string[], toast: (m: string) => void) {
  if (!desktop?.folders || !folders.length) return undefined;
  return async (path: string) => {
    const rel = path.replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, "");
    for (const f of folders) if (await desktop!.folders!.reveal(f, rel).catch(() => false)) return;
    toast(`${rel} isn't in this project's folders`);
  };
}

export function ChatThread({ chat, onPath, toast }: { chat: MeetingChatState; onPath?: (p: string) => void; toast: (m: string) => void }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const turns = chat.messages.filter((m) => m.role !== "note");
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [turns.length, chat.pending]);

  if (!chat.loaded) return <p className="muted"><Loader2 size={14} className="spin" /> Loading the chat…</p>;
  if (!turns.length && !chat.pending) {
    return (
      <div className="chat-empty">
        <MessageSquareText size={22} />
        <p><b>Ask anything about this meeting</b></p>
        <p className="muted">What was decided, who owns what, what someone meant — and, when the meeting's project has linked code, where it lives in the code. The chat is saved with the meeting; keep the useful answers with <b>Add to notes</b>.</p>
      </div>
    );
  }
  const copy = async (text: string) => toast((await api.copyText(text)) ? "Answer copied" : "Couldn't copy");
  return (
    <div className="chat" role="log" aria-live="polite">
      <div className="chat-head">
        <span className="faint">{turns.filter((m) => m.role === "user").length} questions · saved with this meeting</span>
        <button className="link-btn quiet" onClick={() => { if (window.confirm("Clear this meeting's chat? Answers you added to the notes stay.")) void chat.clear(); }}>Clear chat</button>
      </div>
      {turns.map((m) => m.role === "user" ? (
        <div key={m.id} className="chat-q"><div className="bubble">{m.content}</div></div>
      ) : (
        <div key={m.id} className={`chat-a${m.error ? " err" : ""}${m.pinned ? " pinned" : ""}`}>
          {m.error ? <p>{m.content}</p> : <Markdown text={m.content} onPath={onPath} />}
          {!m.error && (
            <div className="chat-actions">
              <button className={`chip-btn${m.pinned ? " on" : ""}`} onClick={() => void chat.pin(m.id, !m.pinned).then(() => toast(m.pinned ? "Removed from the notes" : "Added to the meeting's notes"))}
                title={m.pinned ? "Remove from this meeting's notes" : "Keep this answer in the meeting's notes"}>
                {m.pinned ? <><Check size={13} /> In notes</> : <><NotebookPen size={13} /> Add to notes</>}
              </button>
              <button className="icon-btn ghost sm" aria-label="Copy answer" title="Copy" onClick={() => void copy(m.content)}><Copy size={14} /></button>
              <button className="icon-btn ghost sm" aria-label="Delete answer" title="Delete" onClick={() => void chat.remove(m.id)}><Trash2 size={14} /></button>
            </div>
          )}
        </div>
      ))}
      {chat.pending && (
        <>
          <div className="chat-q"><div className="bubble">{chat.pending}</div></div>
          <div className="chat-a"><p className="muted"><Loader2 size={14} className="spin" /> Thinking…</p></div>
        </>
      )}
      <div ref={endRef} />
    </div>
  );
}

/** Notes tab: what was added to this meeting — kept answers and the user's own notes. */
export function Additions({ chat, onPath, onOpenChat }: { chat: MeetingChatState; onPath?: (p: string) => void; onOpenChat: () => void }) {
  const added = chat.messages.filter((m) => m.pinned);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const save = async () => { const v = text.trim(); if (!v) return; await chat.note(v); setText(""); setWriting(false); };

  return (
    <section className="sec additions">
      <div className="sec-head">
        <h2>Added to this meeting</h2>
        {!writing && <button className="link-btn quiet head-link" onClick={() => setWriting(true)}><Plus size={14} /> Add a note</button>}
      </div>
      {!added.length && !writing && (
        <p className="lead">Details you add — your own notes, or answers from <button className="link-btn" onClick={onOpenChat}>the chat</button> — are kept here, exported with the notes, and used when you ask about this meeting.</p>
      )}
      {added.map((m) => (
        <div key={m.id} className="addition">
          <div className="addition-head">
            <span className="addition-kind">{m.role === "note" ? "Your note" : m.question ? `Q: ${m.question}` : "From the chat"}</span>
            <button className="icon-btn ghost sm" aria-label="Edit" title="Edit" onClick={() => setEditing({ id: m.id, text: m.content })}><Pencil size={13} /></button>
            <button className="icon-btn ghost sm" aria-label="Remove from notes" title="Remove from notes"
              onClick={() => void (m.role === "note" ? chat.remove(m.id) : chat.pin(m.id, false))}><X size={14} /></button>
          </div>
          {editing?.id === m.id ? (
            <div className="addition-edit">
              <textarea className="field-area" value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} autoFocus />
              <div className="row-actions">
                <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
                <button className="btn sm primary" disabled={!editing.text.trim()} onClick={() => void chat.edit(m.id, editing.text.trim()).then(() => setEditing(null))}><Check size={14} /> Save</button>
              </div>
            </div>
          ) : <Markdown text={m.content} onPath={onPath} />}
        </div>
      ))}
      {writing && (
        <div className="addition-edit">
          <textarea className="field-area" value={text} placeholder="A detail, a correction, what happened after… (Markdown works)" aria-label="Your note"
            autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(); }} />
          <div className="row-actions">
            <button className="btn sm" onClick={() => { setWriting(false); setText(""); }}>Cancel</button>
            <button className="btn sm primary" disabled={!text.trim()} onClick={() => void save()}><Check size={14} /> Add to meeting</button>
          </div>
        </div>
      )}
    </section>
  );
}
