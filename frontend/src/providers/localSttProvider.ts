// Speech-to-text on this computer with whisper.cpp (through the Electron bridge). Only the transcribe
// method is real — pair it with a text engine via ComposedProvider. Whisper has no diarization; meeting
// capture already separates "Me" (mic) from everyone else (call audio) by channel.
import type { Provider, TranscribeOpts, Transcription } from "./provider";
import { desktop } from "../desktop/bridge";

const unsupported = () => { throw new Error("Local speech-to-text only transcribes."); };

export class LocalWhisperProvider implements Provider {
  readonly id = "local";
  readonly sttId = "local";
  constructor(private readonly model: string) {}

  async transcribeDiarize(audio: Blob, _filename: string, opts?: TranscribeOpts): Promise<Transcription> {
    if (!desktop) throw new Error("Local transcription needs the desktop app.");
    if (audio.type && !/wav/i.test(audio.type)) throw new Error("Local transcription expects WAV audio.");
    const r = await desktop.stt.transcribe(await audio.arrayBuffer(), { model: this.model, language: opts?.language ?? null });
    return { text: r.text, duration: r.duration, segments: r.segments.map((s) => ({ ...s, speaker: "0" })) };
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
