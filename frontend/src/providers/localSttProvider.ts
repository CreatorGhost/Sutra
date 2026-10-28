// Speech-to-text + speaker separation on this computer (through the Electron bridge; the work runs in
// a utility process — see electron/speech/). Only transcribeDiarize is real — pair it with a text engine
// via ComposedProvider.
//
// Each returned segment carries a diarizer speaker for THIS window ("0", "1", …) and a per-turn
// voiceprint. ingest/channelAttribution store them exactly like cloud segments (remote channel →
// "r<speaker>" + voiceprint, owner mic → "me"), so the cross-window clustering and enrolled-person
// matching in speakerId.ts work unchanged.
import { pcm16ToWav } from "../capture/wav";
import type { Provider, TranscribeOpts, Transcription, AskScope, ExtractOpts } from "./provider";
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
    // ingest asks for no voiceprints on the owner's own mic channel: it is always "Me", so skip the
    // diarizer and embeddings there too.
    const r = await desktop.stt.transcribe(await toWav(audio), { model: this.model, language: opts?.language ?? null, speakers: opts?.voiceprints !== false });
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
  extract(s: object, sys: string, u: string, o?: ExtractOpts) { return this.text.extract(s, sys, u, o); }
  engineId() { return (this.text as any).engineId?.() ?? Promise.resolve(null); }
  chat(s: object, sys: string, u: string, scope?: AskScope | null) { return this.text.chat(s, sys, u, scope); }
  translate(t: string[]) { return this.text.translate(t); }
  refine(t: string[], o?: any) { return this.text.refine(t, o); }
  embed(t: string[]) { return this.text.embed(t); }
  rerank(q: string, d: string[]) { return this.text.rerank(q, d); }
}

/** The local engine reads WAV only. Mic-only recordings are Opus (webm/ogg) from MediaRecorder: decode
 *  them here (each window is a complete file) to 16 kHz mono WAV instead of rejecting them — a rejected
 *  window is lost audio, since Sutra never keeps it. */
export async function toWav(audio: Blob): Promise<ArrayBuffer> {
  if (!audio.type || /wav/i.test(audio.type)) return audio.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await audio.arrayBuffer());
    const pcm = new Int16Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      let v = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) v += buf.getChannelData(c)[i];
      v = Math.max(-1, Math.min(1, v / buf.numberOfChannels));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return pcm16ToWav(pcm, buf.sampleRate, 1);
  } finally {
    void ctx.close();
  }
}
