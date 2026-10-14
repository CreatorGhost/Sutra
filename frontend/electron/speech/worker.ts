// Speech utility process entry (Electron utilityProcess, forked by speech/service.ts; built as
// out/main/speechWorker.cjs). Runs everything heavy off the main process: sherpa-onnx recognition,
// voice-activity detection, speaker diarization, speaker embeddings and model-archive extraction
// (pipeline.ts). Isolation matters beyond responsiveness — onnxruntime aborts the whole process on a
// corrupt model file, which here only kills this worker (the service reports it and respawns), never
// the app.
import { handle } from "./pipeline";
import type { WorkerRequest, WorkerResponse } from "./protocol";

// Jobs run strictly one at a time (the service queues too): recognition already uses every thread
// it is given, and a second concurrent decode would only thrash.
let chain: Promise<unknown> = Promise.resolve();
process.parentPort.on("message", (e: { data: WorkerRequest }) => {
  const msg = e.data;
  chain = chain.then(async () => {
    let res: WorkerResponse;
    try { res = { id: msg.id, ok: true, result: await handle(msg) }; }
    catch (err: any) { res = { id: msg.id, ok: false, error: String(err?.message ?? err) }; }
    process.parentPort.postMessage(res);
  });
});
