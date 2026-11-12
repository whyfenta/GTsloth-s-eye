import jsQR from 'jsqr';
import { QRParts, structuredAppend } from './qr-parts';
import { SMOOTHING, smoothFrame } from './qr-smooth';

/**
 * The side of the square read from each frame: the middle of the picture, scaled down to this many pixels at most. A 1080p
 * frame is read whole: scaling it down loses a dense QR (a prescription of 12 drugs is version 14) held small in the guide.
 */
const MAX_SIDE = 1080;
export interface CameraTexts { title: string; other: string }
function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
function cameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '無法使用相機：請在瀏覽器或手機設定允許這個網站使用相機，再按一次相機鈕。';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '找不到可用的相機。';
  if (name === 'NotReadableError' || name === 'AbortError') return '相機無法開啟，可能正被其他 App 使用；請關閉後再按一次相機鈕。';
  return `相機無法開啟（${name || (error as Error)?.message || '未知錯誤'}）。`;
}
/** Phone cameras that can hold focus on a QR held close do so only when asked. */
function focusContinuously(track: MediaStreamTrack | undefined) {
  const modes = (track?.getCapabilities?.() as { focusMode?: string[] } | undefined)?.focusMode;
  if (track && modes?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => { /* Keeps the camera's own focus. */ });
}
/**
 * Opens the back camera full screen and reads QR codes until read gives a value for one (for linked codes, for all of them joined,
 * with codes their number); a QR it turns down shows texts.other
 * and the camera keeps looking. Resolves with that value, or undefined when closed (the button, Esc or back, or leaving the
 * page); rejects with a message when the camera cannot open. Frames are read in this page only, never kept or sent, and the
 * camera is off as soon as this settles.
 */
export function scanQR<T>(read: (bytes: Uint8Array, codes: number) => T | undefined, texts: CameraTexts): Promise<T | undefined> {
  const dialog = make('dialog', 'qr-camera');
  dialog.setAttribute('aria-label', texts.title);
  const view = make('div', 'qr-camera-view');
  const video = make('video', '');
  video.muted = video.playsInline = true;
  video.setAttribute('playsinline', '');
  const frame = make('span', 'qr-camera-frame');
  frame.setAttribute('aria-hidden', 'true');
  view.append(video, frame);
  const bar = make('div', 'qr-camera-bar');
  const note = make('p', 'qr-camera-note', '開啟相機中…');
  note.setAttribute('role', 'status');
  const close = make('button', 'qr-camera-close', '關閉相機');
  close.type = 'button';
  bar.append(make('p', 'qr-camera-title', texts.title), note, close);
  dialog.append(view, bar);
  document.body.append(dialog);
  dialog.showModal();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  let stream: MediaStream | undefined;
  let settled = false;
  return new Promise<T | undefined>((resolve, reject) => {
    const finish = (value?: T, error?: string) => {
      if (settled) return;
      settled = true;
      stream?.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', closeNow);
      if (dialog.open) dialog.close();
      dialog.remove();
      if (error) reject(new Error(error)); else resolve(value);
    };
    const closeNow = () => finish();
    const hidden = () => { if (document.hidden) finish(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', closeNow);
    close.addEventListener('click', closeNow);
    dialog.addEventListener('close', closeNow);
    // The middle square of each frame, where the guide is: a portrait picture is cropped top and bottom, a landscape one at the sides.
    // Each frame is read one way: as it is, or blurred by the next radius in SMOOTHING for a QR printed in halftone.
    let attempt = 0;
    const parts = new QRParts();
    const scan = () => {
      if (settled) return;
      const { videoWidth: width, videoHeight: height } = video;
      if (width && height) {
        const side = Math.min(width, height), size = Math.round(side * Math.min(1, MAX_SIDE / side));
        if (canvas.width !== size) canvas.width = canvas.height = size;
        context.drawImage(video, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
        const frame = context.getImageData(0, 0, size, size).data;
        const radius = SMOOTHING[attempt++ % SMOOTHING.length];
        const code = jsQR(radius ? smoothFrame(frame, size, size, radius) : frame, size, size, { inversionAttempts: 'dontInvert' });
        if (code) {
          // A message printed as several linked QR codes (Structured Append) is read once every code is in, joined in order.
          const part = structuredAppend(code.chunks);
          const bytes = part ? parts.add(Uint8Array.from(code.binaryData), part) : Uint8Array.from(code.binaryData);
          if (bytes) {
            const value = read(bytes, part?.total ?? 1);
            if (value !== undefined) { finish(value); return; }
            note.textContent = texts.other;
          } else if (part) {
            const { read: done, total } = parts.progress;
            note.textContent = `這張處方的 QR 分成 ${total} 個，已讀到 ${done} 個；請把另一個 QR 放進框內。`;
          }
        }
      }
      requestAnimationFrame(scan);
    };
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then(async opened => {
        stream = opened;
        if (settled) { opened.getTracks().forEach(track => track.stop()); return; }
        focusContinuously(opened.getVideoTracks()[0]);
        video.srcObject = opened;
        await video.play();
        note.textContent = '';
        scan();
      })
      .catch(error => finish(undefined, cameraError(error)));
  });
}
