// F6 — WAV-at-the-edge encoder unit tests. Parse the 44-byte header BACK out of the produced buffer
// and assert every field the multichannel /transcribe upload depends on (RIFF/WAVE/fmt /data, PCM,
// channels=2, sampleRate, 16-bit). No DOM, no Web Audio — pure bytes in/out.
import { describe, it, expect } from "vitest";
import { pcm16ToWav, windowToWavBlob, WAV_HEADER_BYTES } from "../wav";

function ascii(dv: DataView, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
}

describe("pcm16ToWav — canonical 44-byte PCM WAV header", () => {
  it("writes a valid RIFF/WAVE/fmt /data header for stereo 48k 16-bit", () => {
    const frames = 8;
    const channels = 2;
    const sampleRate = 48000;
    const pcm = new Int16Array(frames * channels);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (i % 2 === 0 ? 1 : -1) * (i + 1);

    const buf = pcm16ToWav(pcm, sampleRate, channels);
    const dv = new DataView(buf);
    const dataSize = pcm.length * 2;

    expect(buf.byteLength).toBe(WAV_HEADER_BYTES + dataSize);
    expect(WAV_HEADER_BYTES).toBe(44);

    expect(ascii(dv, 0, 4)).toBe("RIFF");
    expect(dv.getUint32(4, true)).toBe(36 + dataSize); // file size - 8
    expect(ascii(dv, 8, 4)).toBe("WAVE");
    expect(ascii(dv, 12, 4)).toBe("fmt ");
    expect(dv.getUint32(16, true)).toBe(16);            // PCM fmt body
    expect(dv.getUint16(20, true)).toBe(1);             // audioFormat = PCM
    expect(dv.getUint16(22, true)).toBe(channels);      // channels = 2
    expect(dv.getUint32(24, true)).toBe(sampleRate);    // sampleRate
    expect(dv.getUint32(28, true)).toBe(sampleRate * channels * 2); // byteRate
    expect(dv.getUint16(32, true)).toBe(channels * 2);  // blockAlign
    expect(dv.getUint16(34, true)).toBe(16);            // bitsPerSample
    expect(ascii(dv, 36, 4)).toBe("data");
    expect(dv.getUint32(40, true)).toBe(dataSize);
  });

  it("round-trips the PCM samples little-endian after the 44-byte header", () => {
    const pcm = Int16Array.from([100, -100, 32767, -32768, 0, 7]);
    const buf = pcm16ToWav(pcm, 48000, 2);
    const dv = new DataView(buf);
    for (let i = 0; i < pcm.length; i++) {
      expect(dv.getInt16(WAV_HEADER_BYTES + i * 2, true)).toBe(pcm[i]);
    }
  });

  it("uses the window's own sampleRate (not a hardcoded one)", () => {
    const buf = pcm16ToWav(new Int16Array([1, 2]), 16000, 2);
    expect(new DataView(buf).getUint32(24, true)).toBe(16000);
  });

  it("windowToWavBlob produces an audio/wav Blob of the right size", async () => {
    const pcm = new Int16Array(16);
    const blob = windowToWavBlob(pcm, 48000, 2);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(WAV_HEADER_BYTES + pcm.length * 2);
    // The header survives a Blob round-trip (it's the bytes that go on the wire).
    const dv = new DataView(await blob.arrayBuffer());
    expect(ascii(dv, 0, 4)).toBe("RIFF");
    expect(dv.getUint16(22, true)).toBe(2);
  });
});
