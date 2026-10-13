// Speech-to-text + speaker separation on this computer (through the Electron bridge; the work runs in
// a utility process — see electron/speech/). Only transcribeDiarize is real — pair it with a text engine
// via ComposedProvider.
//
// Each returned segment carries a diarizer speaker for THIS window ("0", "1", …) and a per-turn
// voiceprint. ingest/channelAttribution store them exactly like cloud segments (remote channel →
// "r<speaker>" + voiceprint, owner mic → "me"), so the cross-window clustering and enrolled-person
// matching in speakerId.ts work unchanged.
import type { Provider, TranscribeOpts, Transcription } from "./provider";
import { desktop } from "../desktop/bridge";

const unsupported = () => { throw new Error("Local speech-to-text only transcribes."); };

export class LocalSpeechProvider implements Provider {
  readonly id = "local";
  readonly sttId = "local";
  constructor(private readonly model: string) {}

  /** `translated: false` in English mode tells ingest the model kept the original language, so the
   *  text engine's translate pass must run. */
  async transcribeDiarize(audio: Blob, _filename: string, opts?: TranscribeOpts): Promise<Transcription & { translated?: boolean }> {
    if (!desktop) throw new Error("Local transcription needs the desktop app.");
    if (audio.type && !/wav/i.test(audio.type)) throw new Error("Local transcription expects WAV audio.");
    // ingest asks for no voiceprints on the owner's own mic channel: it is always "Me", so skip the
    // diarizer and embeddings there too.
    const r = await desktop.stt.transcribe(await audio.arrayBuffer(), { model: this.model, language: opts?.language ?? null, speakers: opts?.voiceprints !== false });
    return {
      text: r.text, duration: r.duration, translated: r.translated,
      segments: r.segments.map((s) => ({ speaker: s.speaker, start: s.start, end: s.end, text: s.text, embedding: s.embedding })),
    };
  }
  extract = unsupported as any;
  chat = unsupported as any;
  translate = unsupported as any;
  refine = unsupported as any;
  embed = unsupported as any;
  rerank = unsupported as any;
}

/** Transcription from one engine, everything textual from another. */
export class ComposedProvider implements Provider {
  readonly id: string;
  readonly sttId: string;
  readonly canEmbed: boolean;
  constructor(private readonly stt: Provider, private readonly text: Provider) {
    this.id = text.id;
    this.sttId = stt.sttId ?? stt.id;
    this.canEmbed = text.canEmbed !== false;
  }
  transcribeDiarize(a: Blob, f: string, o?: TranscribeOpts) { return this.stt.transcribeDiarize(a, f, o); }
  extract(s: object, sys: string, u: string) { return this.text.extract(s, sys, u); }
  chat(s: object, sys: string, u: string) { return this.text.chat(s, sys, u); }
  translate(t: string[]) { return this.text.translate(t); }
  refine(t: string[], o?: any) { return this.text.refine(t, o); }
  embed(t: string[]) { return this.text.embed(t); }
  rerank(q: string, d: string[]) { return this.text.rerank(q, d); }
}
