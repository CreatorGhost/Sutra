import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { exportBackup, importBackup } from "../../lib/backup";
import { desktop } from "../../desktop/bridge";
import { friendlyError } from "../ui";
import { Group, Row, type SectionProps } from "./kit";

type Picked = { file: File; exportedAt: string | null; conversations: number | null; people: number | null };

/** Peek inside a picked file so the confirm step can say what it's about to restore. */
async function inspect(file: File): Promise<Picked> {
  try {
    const env = JSON.parse(await file.text());
    const tables: any[] = Array.isArray(env?.data?.tables) ? env.data.tables : [];
    const count = (n: string) => { const t = tables.find((x) => x?.name === n); return Array.isArray(t?.values) ? t.values.length : null; };
    return { file, exportedAt: typeof env?.exported_at === "string" ? env.exported_at : null, conversations: count("conversations"), people: count("people") };
  } catch {
    return { file, exportedAt: null, conversations: null, people: null };
  }
}

const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function BackupSection({ toast }: SectionProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [restoring, setRestoring] = useState(false);

  const doExport = async () => {
    setSaving(true);
    try {
      const r = await exportBackup();
      if (r) { setSaved(`${r.uri ?? r.filename} · ${fmtBytes(r.bytes)}`); toast("Backup saved"); }
    } catch (e) { toast(friendlyError(e)); }
    finally { setSaving(false); }
  };
  const doRestore = async () => {
    if (!picked) return;
    setRestoring(true);
    try {
      await importBackup(picked.file);
      // Rebuild the whole app against the restored data.
      window.location.reload();
    } catch (e) {
      toast(friendlyError(e));
      setRestoring(false);
      setPicked(null);
    }
  };

  const facts = picked && [
    picked.exportedAt && `saved ${new Date(picked.exportedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
    picked.conversations != null && `${picked.conversations} conversation${picked.conversations === 1 ? "" : "s"}`,
    picked.people != null && `${picked.people} ${picked.people === 1 ? "person" : "people"}`,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <Group label="Backup" hint="The file isn't encrypted — anyone who has it can read your notes. Keep it somewhere private.">
        <Row title="Save a backup" desc={saved ? <>Saved <code>{saved}</code></> : "Everything Sutra knows — meetings, notes, people, your context and settings — in one file you keep."}>
          <button className="btn sm" onClick={() => void doExport()} disabled={saving}><Download size={14} /> {saving ? "Saving…" : "Save…"}</button>
        </Row>
      </Group>

      <Group label="Restore" hint={desktop ? "Works with backups from the Sutra phone app too." : undefined}>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void inspect(f).then(setPicked); }} />
        {!picked ? (
          <Row title="Restore from a backup" desc="Replaces everything in Sutra with the backup's contents.">
            <button className="btn sm" onClick={() => fileRef.current?.click()}><Upload size={14} /> Choose file…</button>
          </Row>
        ) : (
          <Row title={`Replace everything with ${picked.file.name}?`}
            desc={<>{facts ? `${facts}. ` : ""}What's in Sutra now is erased and Sutra restarts. Save a backup first if you might want it back.</>}>
            <div className="actions">
              <button className="btn sm" onClick={() => setPicked(null)} disabled={restoring}>Cancel</button>
              <button className="btn sm danger" onClick={() => void doRestore()} disabled={restoring}>{restoring ? "Restoring…" : "Replace everything"}</button>
            </div>
          </Row>
        )}
      </Group>
    </>
  );
}
