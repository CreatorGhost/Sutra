// Everything through the paired Mac. Audio windows go up in chunks and the Mac transcribes them with
// its own local speech engine (so this behaves like LocalSpeechProvider in ingest: voiceprints, and a
// translate pass when the model kept the spoken language). Every text job runs on the AI engine
// chosen on the Mac — or the one picked on the phone (paired_ai_engine / paired_ai_model).
import type { AskScope, Provider, RefineOpts, TranscribeOpts, Transcription } from "./provider";
import type { AgentId } from "../shared/agentProtocol";
import { b64u, randomBytes } from "../shared/pairing/crypto";
import type { SecureLink } from "../shared/pairing/link";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES, type AiFn } from "../shared/pairing/protocol";

/** Where the link comes from (the connection supervisor; a fake in tests). */
export interface LinkSource { whenOnline(timeoutMs?: number): Promise<SecureLink> }

const WAIT_FOR_MAC_MS = 20_000;
const CHUNK_TIMEOUT_MS = 60_000;
// Generous: the Mac may be loading its speech model, or its AI engine may be thinking for a while.
const STT_TIMEOUT_MS = 300_000;
const AI_TIMEOUT_MS = 300_000;

/** Send bytes to the Mac in relay-sized chunks (blob.put); returns the id later requests refer to. */
export async function uploadBlob(link: SecureLink, bytes: Uint8Array): Promise<string> {
  const blobId = b64u(randomBytes(12));
  for (let seq = 0, off = 0; ; seq++) {
    const end = Math.min(off + BLOB_CHUNK_BYTES, bytes.length);
    const last = end >= bytes.length;
    await link.request("blob.put", { id: blobId, seq, last, data: b64u(bytes.subarray(off, end)) }, CHUNK_TIMEOUT_MS);
    off = end;
    if (last) return blobId;
  }
}

export class PairedMacProvider implements Provider {
  readonly id = "mac";
  readonly sttId = "local";
  readonly canEmbed = false;

  constructor(private readonly source: () => LinkSource, private readonly choice: { engine: AgentId | null; model: string | null }) {}

  private link(): Promise<SecureLink> { return this.source().whenOnline(WAIT_FOR_MAC_MS); }

  async transcribeDiarize(audio: Blob, filename: string, opts?: TranscribeOpts): Promise<Transcription & { translated?: boolean }> {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (bytes.length > MAX_BLOB_BYTES) throw new Error("This recording is too large to send to your Mac.");
    const link = await this.link();
    const blobId = await uploadBlob(link, bytes);
    const r = await link.request("stt.transcribe", { blobId, mime: audio.type, filename, opts: opts ? { ...opts } : undefined }, STT_TIMEOUT_MS);
    return r as Transcription & { translated?: boolean };
  }

  private async ai(fn: AiFn, args: unknown[]): Promise<any> {
    const link = await this.link();
    return link.request("ai.call", { fn, args, engine: this.choice.engine, model: this.choice.model }, AI_TIMEOUT_MS);
  }

  extract(jsonSchema: object, system: string, user: string) { return this.ai("extract", [jsonSchema, system, user]); }
  /** A project question names the project and meeting; the Mac finds that project's folders itself
   *  (the phone has no folder paths, and wouldn't be trusted with them). */
  chat(jsonSchema: object, system: string, user: string, scope?: AskScope | null) {
    const hint = scope && (scope.projectName || scope.meetingUid) ? { projectName: scope.projectName ?? null, meetingUid: scope.meetingUid ?? null } : null;
    return this.ai("chat", hint ? [jsonSchema, system, user, hint] : [jsonSchema, system, user]);
  }
  translate(texts: string[]): Promise<string[]> { return texts.length ? this.ai("translate", [texts]) : Promise.resolve([]); }
  refine(texts: string[], opts?: RefineOpts): Promise<string[]> { return texts.length ? this.ai("refine", [texts, opts ?? {}]) : Promise.resolve([]); }
  rerank(query: string, docs: string[]): Promise<number[]> { return this.ai("rerank", [query, docs]); }
  /** The Mac's AI engines can't embed, so search runs on keywords (canEmbed = false). */
  async embed(): Promise<number[][]> { throw new Error("Embeddings aren't available through your Mac."); }
}
