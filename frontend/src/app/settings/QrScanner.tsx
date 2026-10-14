// Full-screen camera sheet that reads the pairing QR shown on the Mac. Uses the platform's
// BarcodeDetector when it can read QR codes, else jsQR (loaded only when needed) on video frames.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { PAIR_LINK_PREFIX } from "../../shared/pairing/protocol";

type Detect = (v: HTMLVideoElement) => Promise<string | null>;

async function makeDetector(): Promise<Detect> {
  const BD = (globalThis as any).BarcodeDetector;
  if (BD) {
    try {
      const formats: string[] | undefined = await BD.getSupportedFormats?.();
      if (!formats || formats.includes("qr_code")) {
        const d = new BD({ formats: ["qr_code"] });
        return async (v) => ((await d.detect(v)) as { rawValue?: string }[])[0]?.rawValue ?? null;
      }
    } catch { /* fall back to jsQR */ }
  }
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (v) => {
    if (!ctx || !v.videoWidth || !v.videoHeight) return null;
    // A pairing QR fills much of the frame; ~720 px on the long side is plenty and keeps it fast.
    const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
  };
}

function cameraError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Sutra needs the camera to scan the code. Allow camera access, or paste the pairing link instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found. Paste the pairing link instead.";
  return "The camera couldn't start. Paste the pairing link instead.";
}

export function QrScanner({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const done = useRef(onCode);
  done.current = onCode;

  useEffect(() => {
    let alive = true;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (!alive) return;
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const detect = await makeDetector();
        const tick = async () => {
          if (!alive) return;
          const text = await detect(v).catch(() => null);
          if (!alive) return;
          if (text && text.includes(PAIR_LINK_PREFIX)) { done.current(text); return; }
          if (text) setHint("That isn't a Sutra pairing code — scan the one in Settings → Phones on your Mac.");
          timer = setTimeout(() => void tick(), 180);
        };
        void tick();
      } catch (e) {
        if (alive) setError(cameraError(e));
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Portalled so no animated ancestor can clip the full-screen sheet.
  return createPortal(
    <div className="qr-sheet" role="dialog" aria-modal="true" aria-label="Scan pairing code">
      <video ref={video} className="qr-video" playsInline muted />
      <div className="qr-frame" aria-hidden="true" />
      <button className="icon-btn qr-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
      <p className="qr-text">{error ?? hint ?? "Point your camera at the code on your Mac — Settings → Phones."}</p>
    </div>,
    document.body,
  );
}
