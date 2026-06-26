// AudioWorklet PCM encoder for online-meeting two-channel capture (ticket F2).
// Runs on the audio render thread. Receives a 2-channel input (channel 0 = mic "Me", channel 1 =
// system/remotes — wired by a ChannelMerger(2) in the main thread) and posts INTERLEAVED linear16
// (Int16) stereo PCM back to the page via port.postMessage. The main-thread StereoWindowBuffer
// slices those into ~90s in-RAM windows. Audio is never written anywhere here — it is posted to the
// page and discarded each render quantum.
//
// Plain JS (no TS): loaded with audioWorklet.addModule('/worklets/pcm-encoder.js') and not part of
// the bundled/type-checked src tree. Lives in public/ so the URL is stable in dev and packaged builds.

function floatToInt16(sample) {
  // Clamp to [-1, 1] then scale. Use the asymmetric 16-bit range like linear16 PCM elsewhere.
  const s = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

class PcmEncoderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    // No connected input (or a silent quantum with no channels) → keep the processor alive.
    if (!input || input.length === 0) return true;

    const mic = input[0];
    // If the merger only delivered one channel this quantum, duplicate it so output stays stereo;
    // the upstream no-audio-track guard is what actually prevents a genuinely mono session.
    const system = input.length > 1 ? input[1] : input[0];
    const frames = mic ? mic.length : 0;
    if (frames === 0) return true;

    const interleaved = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      interleaved[i * 2] = floatToInt16(mic[i]); // channel 0 = Me
      interleaved[i * 2 + 1] = floatToInt16(system ? system[i] : 0); // channel 1 = remotes
    }
    // Transfer the buffer so we don't copy across the thread boundary.
    this.port.postMessage(interleaved, [interleaved.buffer]);
    return true;
  }
}

registerProcessor("pcm-encoder", PcmEncoderProcessor);
