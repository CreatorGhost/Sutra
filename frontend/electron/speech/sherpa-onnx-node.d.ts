// Minimal types for the parts of sherpa-onnx-node (plain JS + JSDoc, no .d.ts) that worker.ts uses.
declare module "sherpa-onnx-node" {
  interface Waveform { samples: Float32Array; sampleRate: number }
  export class OfflineStream { acceptWaveform(w: Waveform): void }
  export class OfflineRecognizer {
    static createAsync(config: object): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(s: OfflineStream): Promise<{ text: string; lang?: string; timestamps?: number[] }>;
  }
  export class Vad {
    constructor(config: object, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
    pop(): void;
    flush(): void;
    reset(): void;
  }
  export class OfflineSpeakerDiarization {
    constructor(config: object);
    sampleRate: number;
    process(samples: Float32Array): { start: number; end: number; speaker: number }[];
  }
  export class OnlineStream { acceptWaveform(w: Waveform): void; inputFinished(): void }
  export class SpeakerEmbeddingExtractor {
    constructor(config: object);
    dim: number;
    createStream(): OnlineStream;
    isReady(s: OnlineStream): boolean;
    compute(s: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
  }
  export const version: string;
}
