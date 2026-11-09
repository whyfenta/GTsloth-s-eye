/**
 * Blur radii, in pixels of the square read from each frame, tried in turn with the frame as it is: one per frame. A QR printed in
 * halftone, its black a dither of dots on grainy paper as some prescription printers and copiers make it, breaks into specks that
 * hide its finder patterns from jsQR; blurring merges the dots back into modules, as a phone's own camera app does. Which radius
 * merges them depends on how far the phone is held, so a few are tried; the plain frame comes first for a QR printed solid.
 */
export const SMOOTHING = [0, 2, 1, 3];

/** A frame's grey levels, box-blurred across and then down by radius pixels, as RGBA for jsQR. Edges repeat their last pixel. */
export function smoothFrame(rgba: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const grey = new Float32Array(width * height), across = new Float32Array(width * height), span = 2 * radius + 1;
  for (let i = 0, p = 0; i < grey.length; i++, p += 4) grey[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) / 256;
  const at = (value: number, last: number) => Math.min(last, Math.max(0, value));
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += grey[row + at(x, width - 1)];
    for (let x = 0; x < width; x++) {
      across[row + x] = sum / span;
      sum += grey[row + at(x + radius + 1, width - 1)] - grey[row + at(x - radius, width - 1)];
    }
  }
  const out = new Uint8ClampedArray(rgba.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += across[at(y, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      const p = (y * width + x) * 4;
      out[p] = out[p + 1] = out[p + 2] = sum / span;
      out[p + 3] = 255;
      sum += across[at(y + radius + 1, height - 1) * width + x] - across[at(y - radius, height - 1) * width + x];
    }
  }
  return out;
}
