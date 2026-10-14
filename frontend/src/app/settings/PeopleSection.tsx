import { useEffect, useState } from "react";
import { Pencil, Trash2, UserCheck, UserPlus } from "lucide-react";
import { api } from "../../local/sutra";
import { notifyDataChanged } from "../events";
import { friendlyError } from "../ui";
import { Group, Row, RowMenu, type SectionProps } from "./kit";

type Person = { id: number; canonical_name: string; is_me: number; provisional: number; has_voiceprint: number };

/** The people Sutra knows: you first, who it recognizes by voice, rename / mark as me / delete / add. */
export function PeopleSection({ toast }: SectionProps) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [newName, setNewName] = useState("");

  const reload = async () => setPeople((await api.listPeople()) as Person[]);
  useEffect(() => { void reload(); }, []);

  // Every change refreshes the list and tells the rest of the app (speaker names in open notes).
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); await reload(); notifyDataChanged(); if (done) toast(done); }
    catch (e) { toast(friendlyError(e)); }
  };
  const saveRename = (p: Person) => {
    const n = draft.trim();
    setEditing(null);
    if (n && n !== p.canonical_name) void act(() => api.renamePerson(p.id, n), "Renamed");
  };
  const add = () => {
    const n = newName.trim();
    if (!n) return;
    const fd = new FormData();
    fd.set("name", n);
    fd.set("is_me", String(!people?.some((p) => p.is_me)));
    setNewName("");
    void act(() => api.enroll(fd), `Added ${n}`);
  };

  return (
    <>
      <Group label="People" hint="Name a speaker inside any meeting and Sutra learns their voice, so it can tell who's talking next time.">
        {people && people.length === 0 && <div className="set-empty">No one yet. Add yourself first so your lines are always tagged as you.</div>}
        {people?.map((p) => {
          if (editing === p.id) {
            return (
              <Row key={p.id} title={<input type="text" autoFocus value={draft} aria-label="Name" style={{ maxWidth: "100%", width: 240 }}
                onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveRename(p); if (e.key === "Escape") setEditing(null); }} />}>
                <div className="actions">
                  <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="btn sm primary" onClick={() => saveRename(p)} disabled={!draft.trim()}>Save</button>
                </div>
              </Row>
            );
          }
          if (confirmDelete === p.id) {
            return (
              <Row key={p.id} title={`Delete ${p.canonical_name}?`} desc="Their lines stay in your notes, just without a name. Their voice is forgotten.">
                <div className="actions">
                  <button className="btn sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                  <button className="btn sm danger" onClick={() => { setConfirmDelete(null); void act(() => api.deletePerson(p.id), "Deleted"); }}>Delete</button>
                </div>
              </Row>
            );
          }
          return (
            <Row key={p.id}
              title={<>{p.canonical_name}{!!p.is_me && <span className="badge">You</span>}{!!p.has_voiceprint && <span className="badge dim">Voice</span>}</>}
              desc={p.provisional ? "Unnamed speaker" : p.has_voiceprint ? "Recognized by voice" : "Voice is learned the first time you name them in a meeting"}>
              <RowMenu label={`Options for ${p.canonical_name}`} items={[
                { label: "Rename", icon: <Pencil size={15} />, onSelect: () => { setDraft(p.canonical_name); setEditing(p.id); } },
                ...(p.is_me ? [] : [{ label: "This is me", icon: <UserCheck size={15} />, onSelect: () => void act(() => api.setMe(p.id), `${p.canonical_name} is now you`) }]),
                { label: "Delete", icon: <Trash2 size={15} />, danger: true, onSelect: () => setConfirmDelete(p.id) },
              ]} />
            </Row>
          );
        })}
      </Group>

      <Group label="Add someone">
        <Row title={<input type="text" value={newName} placeholder="Name" aria-label="New person's name" style={{ maxWidth: "100%", width: 240 }}
          onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />}>
          <button className="btn sm" onClick={add} disabled={!newName.trim()}><UserPlus size={15} /> Add</button>
        </Row>
      </Group>
    </>
  );
}
