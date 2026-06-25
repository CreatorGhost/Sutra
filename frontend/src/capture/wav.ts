// F6 — WAV-at-the-edge encoder for online-meeting capture.
//
// A completed two-channel CaptureWindow (interleaved linear16 PCM, mic→ch0 "Me", system→ch1 remotes;
// see stereoCore.ts / CaptureProvider.ts) is wrapped into a minimal canonical WAV in-flight, purely so
// it can ride the EXISTING multipart /transcribe upload (api.ingestWindow → provider.transcribeDiarize).
// The blob exists only for that single in-flight request and is never written to disk/IndexedDB/sql.js
// — same audio-never-persisted invariant as the rest of the pipeline.
//
// PURE: no DOM, no Web Audio, no storage. Unit-tested by parsing the 44-byte header back (wav.test.ts).

/** Canonical 44-byte PCM WAV header size (RIFF + fmt + data chunks, no extras). */
export const WAV_HEADER_BYTES = 44;

/**
 * Encode interleaved 16-bit PCM into a canonical 44-byte-header WAV ArrayBuffer.
 * Layout: "RIFF" <size> "WAVE" "fmt " <16> <PCM=1> <channels> <sampleRate> <byteRate>
 *         <blockAlign> <bitsPerSample=16> "data" <dataSize> <samples…>.
 * @param pcm interleaved linear16 samples (length = frames * channels)
 */
export function pcm16ToWav(pcm: Int16Array, sampleRate: number, channels: number): ArrayBuffer {
  const bytesPerSample = 2; // 16-bit
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * bytesPerSample;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const dv = new DataView(buf);
  const ascii = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true); // RIFF chunk size = file size - 8
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true);           // fmt chunk body size (PCM)
  dv.setUint16(20, 1, true);            // audioFormat = 1 (PCM)
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);           // bitsPerSample
  ascii(36, "data");
  dv.setUint32(40, dataSize, true);

  // Little-endian 16-bit samples.
  let off = WAV_HEADER_BYTES;
  for (let i = 0; i < pcm.length; i++, off += 2) dv.setInt16(off, pcm[i], true);
  return buf;
}

/** Wrap a CaptureWindow's stereo PCM into an `audio/wav` Blob (in-flight only — never stored). */
export function windowToWavBlob(pcm: Int16Array, sampleRate: number, channels: number): Blob {
  return new Blob([pcm16ToWav(pcm, sampleRate, channels)], { type: "audio/wav" });
}
