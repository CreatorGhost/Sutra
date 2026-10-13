import { useEffect, useState } from "react";
import { Check, Pencil, Plus, Replace, Share2, Trash2 } from "lucide-react";
import { api } from "../../local/sutra";
import { friendlyError } from "../ui";
import { Group, Row, RowMenu, SwitchRow, type SectionProps } from "./kit";

// "Your Context" (priors): beliefs about the user's world that ground answers. We surface DECAY, never
// a raw score — the same half-life recency the repo ranks with (0.5^(ageDays/halfLife)) from
// last_confirmed_at (else created_at), bucketed into Strong / Fading / Stale.
const KINDS = ["person", "project", "org", "role", "topic", "goal", "pref"] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<string, string> = { person: "Person", project: "Project", org: "Organization", role: "Role", topic: "Topic", goal: "Goal", pref: "Preference" };

export function freshness(p: { last_confirmed_at?: string | null; created_at?: string | null }, halfLifeDays: number, now = Date.now()): "New" | "Strong" | "Fading" | "Stale" {
  const ts = p.last_confirmed_at || p.created_at;
  if (!ts) return "New";
  const t = Date.parse(String(ts).includes("T") ? String(ts) : String(ts).replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return "Strong";
  const rec = Math.pow(0.5, (now - t) / 86400000 / Math.max(0.5, halfLifeDays));
  return rec >= 0.66 ? "Strong" : rec >= 0.33 ? "Fading" : "Stale";
}

type Prior = { id: number; kind: string; entity_id: number | null; subject: string; value: string | null; status: string; provenance: string; share_cloud: number; superseded_by: number | null; last_confirmed_at: string | null; created_at: string };
type Draft = { subject: string; value: string };

export function ContextSection({ settings, put, toast }: SectionProps) {
  const [priors, setPriors] = useState<Prior[] | null>(null);
  const [edit, setEdit] = useState<{ id: number; mode: "edit" | "replace"; draft: Draft } | null>(null);
  const [add, setAdd] = useState<{ subject: string; value: string; kind: Kind }>({ subject: "", value: "", kind: "person" });
  // share_cloud = this belief may leave the device: with a question a cloud model answers, and to your
  // AI tools over MCP (handlers only serve share_cloud=1). Off by default, per belief.
  const shareLabel = "Share beyond this device";

  const reload = async () => setPriors((await api.listPriors()) as Prior[]);
  useEffect(() => { void reload(); }, []);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); await reload(); if (done) toast(done); } catch (e) { toast(friendlyError(e)); }
  };

  const halfLife = Number(settings["prior_half_life_days"] ?? 60) || 60;
  const enabled = settings["context_enabled"] !== false;
  // Superseded / dismissed beliefs stay in the DB (history) but leave the list.
  const active = (priors ?? []).filter((p) => p.superseded_by == null && p.status !== "dismissed");
  const suggested = active.filter((p) => p.status !== "confirmed");
  const confirmed = active.filter((p) => p.status === "confirmed");

  const save = () => {
    if (!edit || !edit.draft.subject.trim()) return;
    const old = active.find((p) => p.id === edit.id);
    const { subject, value } = edit.draft;
    setEdit(null);
    if (edit.mode === "edit") {
      void act(async () => {
        await api.editPrior(edit.id, { subject: subject.trim(), value: value.trim() || null });
      }, "Saved");
    } else if (old) {
      void act(() => api.supersedePrior(old.id, { kind: old.kind, entity_id: old.entity_id ?? null, subject: subject.trim(), value: value.trim() || null, provenance: "user", status: "confirmed" }), "Replaced");
    }
  };
  const addPrior = () => {
    if (!add.subject.trim()) return;
    const p = { kind: add.kind, subject: add.subject.trim(), value: add.value.trim() || null, provenance: "user", status: "confirmed", confidence: 0.8, last_confirmed_at: new Date().toISOString() };
    setAdd({ subject: "", value: "", kind: add.kind });
    void act(() => api.addPrior(p), "Added to your context");
  };

  const item = (p: Prior) => {
    if (edit?.id === p.id) {
      const d = edit.draft;
      const set = (patch: Partial<Draft>) => setEdit({ ...edit, draft: { ...d, ...patch } });
      return (
        <div key={p.id} className="set-row stack">
          {edit.mode === "replace" && <div className="d">Write what's true now. The old version is kept, but no longer used.</div>}
          <div className="set-field two">
            <input value={d.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="What it's about" aria-label="What it's about" autoFocus />
            <input value={d.value} onChange={(e) => set({ value: e.target.value })} placeholder={edit.mode === "replace" ? "e.g. now leads design" : "Detail (optional)"} aria-label="Detail" />
          </div>
          <div className="actions">
            <button className="btn sm" onClick={() => setEdit(null)}>Cancel</button>
            <button className="btn sm primary" onClick={save} disabled={!d.subject.trim()}>{edit.mode === "replace" ? "Replace" : "Save"}</button>
          </div>
        </div>
      );
    }
    const fresh = freshness(p, halfLife);
    const meta = [KIND_LABEL[p.kind] ?? p.kind, p.status === "confirmed" ? fresh : p.provenance === "user" ? "Added by you" : "Noticed in your conversations"];
    return (
      <Row key={p.id}
        title={<>{p.subject}{!!p.share_cloud && <span className="badge dim">Shared</span>}</>}
        desc={<>{p.value && <span style={{ color: "var(--text)" }}>{p.value} · </span>}{meta.join(" · ")}</>}>
        <div className="actions">
          {p.status !== "confirmed" && <button className="btn sm" onClick={() => void act(() => api.confirmPrior(p.id), "Confirmed")}><Check size={15} /> Keep</button>}
          <RowMenu label={`Options for ${p.subject}`} items={[
            ...(p.status === "confirmed" && fresh !== "Strong" ? [{ label: "Still true", icon: <Check size={15} />, onSelect: () => void act(() => api.confirmPrior(p.id), "Refreshed") }] : []),
            { label: "Edit", icon: <Pencil size={15} />, onSelect: () => setEdit({ id: p.id, mode: "edit", draft: { subject: p.subject, value: p.value ?? "" } }) },
            { label: p.share_cloud ? "Keep on this device" : shareLabel, icon: <Share2 size={15} />, onSelect: () => void act(() => api.setPriorShareCloud(p.id, !p.share_cloud), p.share_cloud ? "Kept on this device" : "Shared") },
            { label: "Replace with what's true now", icon: <Replace size={15} />, onSelect: () => setEdit({ id: p.id, mode: "replace", draft: { subject: p.subject, value: "" } }) },
            { label: p.status === "confirmed" ? "Forget" : "Dismiss", icon: <Trash2 size={15} />, danger: true, onSelect: () => void act(() => api.dismissPrior(p.id)) },
          ]} />
        </div>
      </Row>
    );
  };

  return (
    <>
      <Group hint="Beliefs, not facts: they fade unless they keep coming up. Only the ones marked Shared ever leave this device — to cloud answers and to your AI tools.">
        <SwitchRow title="Use my context in answers" desc="Lets Sutra lean on what it knows about you and the people, projects and goals in your life."
          checked={enabled} onChange={(v) => void put({ context_enabled: v })} />
      </Group>

      {suggested.length > 0 && <Group label="Suggested">{suggested.map(item)}</Group>}

      <Group label="Your context">
        {priors && !confirmed.length && <div className="set-empty">Nothing here yet. Keep the suggestions that are right, or add something below.</div>}
        {confirmed.map(item)}
      </Group>

      <Group label="Add to your context">
        <div className="set-row stack">
          <div className="set-field two">
            <input value={add.subject} onChange={(e) => setAdd({ ...add, subject: e.target.value })} placeholder="What it's about — e.g. Priya" aria-label="What it's about" />
            <input value={add.value} onChange={(e) => setAdd({ ...add, value: e.target.value })} placeholder="Detail — e.g. my manager" aria-label="Detail"
              onKeyDown={(e) => { if (e.key === "Enter") addPrior(); }} />
          </div>
          <div className="actions" style={{ justifyContent: "space-between" }}>
            <div className="set-field" style={{ width: 170 }}>
              <select value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value as Kind })} aria-label="Type">
                {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </div>
            <button className="btn sm" onClick={addPrior} disabled={!add.subject.trim()}><Plus size={15} /> Add</button>
          </div>
        </div>
      </Group>
    </>
  );
}
