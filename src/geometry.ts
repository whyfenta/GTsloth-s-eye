export function rotateCanvas(source: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  if (!degrees) return source;
  const radians = degrees * Math.PI / 180; const c = Math.abs(Math.cos(radians)); const s = Math.abs(Math.sin(radians));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * c + source.height * s); canvas.height = Math.round(source.height * c + source.width * s);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2); context.rotate(radians);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}
export function cropCanvas(source: HTMLCanvasElement, box: { x: number; y: number; width: number; height: number }): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(box.width)); canvas.height = Math.max(1, Math.round(box.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
export function deskewAngle(source: HTMLCanvasElement): number {
  const small = document.createElement('canvas'); small.width = 800;
  small.height = Math.round(source.height * 800 / source.width);
  const ctx = small.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(source, 0, 0, small.width, small.height);
  const { data } = ctx.getImageData(0, 0, small.width, small.height);
  const points: [number, number][] = [];
  for (let y = 0; y < small.height; y += 2) for (let x = 15; x < 785; x += 2) {
    const i = (y * small.width + x) * 4;
    if (data[i] + data[i + 1] + data[i + 2] < 330) points.push([x - 400, y]);
  }
  if (points.length < 100) return 0;
  let best = 0; let bestScore = -1; let zeroScore = 0;
  for (let angle = -3; angle <= 3.001; angle += .25) {
    const counts = new Uint32Array(small.height + 60); const tangent = Math.tan(angle * Math.PI / 180);
    for (const [x, y] of points) { const projected = Math.round(y + x * tangent) + 30; if (projected >= 0 && projected < counts.length) counts[projected]++; }
    let score = 0; for (const n of counts) score += n * n;
    if (Math.abs(angle) < .01) zeroScore = score;
    if (score > bestScore) { best = angle; bestScore = score; }
  }
  small.width = small.height = 1;
  return bestScore > zeroScore * 1.12 ? best : 0;
}
/** Scales a canvas (high-quality smoothing) and pads it with white, as Tesseract reads padded text better. */
export function scaleCanvas(source: HTMLCanvasElement, factor: number, pad = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * factor) + pad * 2); canvas.height = Math.max(1, Math.round(source.height * factor) + pad * 2);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(source, pad, pad, canvas.width - pad * 2, canvas.height - pad * 2);
  return canvas;
}
/** Black/white in place with Otsu's threshold, which removes scan grey and JPEG noise around digits. */
export function binarize(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!; const image = ctx.getImageData(0, 0, canvas.width, canvas.height); const d = image.data;
  const histogram = new Uint32Array(256); const gray = new Uint8Array(d.length / 4);
  for (let i = 0; i < gray.length; i++) { gray[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000; histogram[gray[i]]++; }
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let below = 0, belowSum = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    below += histogram[t]; if (!below || below === gray.length) continue; belowSum += t * histogram[t];
    const above = gray.length - below; const between = below * above * (belowSum / below - (sum - belowSum) / above) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  for (let i = 0; i < gray.length; i++) { const v = gray[i] <= threshold ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  ctx.putImageData(image, 0, 0); return canvas;
}
