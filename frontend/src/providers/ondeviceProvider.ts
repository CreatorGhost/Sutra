import type { Provider, Transcription } from "./provider";

/** STUB — interface only. On-device models (sherpa-onnx ASR/diarization, EmbeddingGemma, Gemma 3n)
 *  are a post-funding roadmap item (Phase 3/4). Each must clear the eval-harness Hinglish bar before
 *  it can become a default. Until then this provider reports unavailability. */
export class OnDeviceProvider implements Provider {
  readonly id = "ondevice";
  private fail(): never {
    throw new Error("On-device intelligence is not installed yet (max-privacy mode is Phase 3/4).");
  }
  async transcribeDiarize(): Promise<Transcription> { this.fail(); }
  async extract(): Promise<any> { this.fail(); }
  async translate(): Promise<string[]> { this.fail(); }
  async refine(): Promise<string[]> { this.fail(); }
  async embed(): Promise<number[][]> { this.fail(); }
  async rerank(): Promise<number[]> { this.fail(); }
  async chat(): Promise<any> { this.fail(); }
}
