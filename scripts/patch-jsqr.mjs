// Teaches the installed jsQR 1.4.0 the QR Structured Append header (mode 0011), run by npm install and npm ci (postinstall).
// Some hospitals print one prescription as 2 or more QR codes joined this way: each starts with a 20-bit header (mode 0011, its
// index, the number of codes less one, and a parity byte the same in all of them) before the data. jsQR does not know the mode
// and reads the index as the next mode, so the first code reads as empty and the second as digits that were never there.
// With the patch the header becomes a chunk { type: 'structuredappend', index, total, parity } and the data reads as printed;
// src/qr-camera.ts joins the parts. Idempotent; fails the install when the jsQR source is not the one this was written for.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MARK = '/* gtsloth: structured append */';
const ANCHOR = `        if (mode === ModeByte.Terminator) {
            return result;
        }
`;
const PATCH = `        if (mode === ModeByte.Terminator) {
            return result;
        }
        else if (mode === 3) { ${MARK}
            result.chunks.push({ type: "structuredappend", index: stream.readBits(4), total: stream.readBits(4) + 1, parity: stream.readBits(8) });
        }
`;
/** The jsQR source with the patch, unchanged when it is already there; throws when the decoder loop is not as expected. */
export function patchJsQR(source) {
  if (source.includes(MARK)) return source;
  const normalized = source.replace(/\r\n/g, '\n');
  if (normalized.split(ANCHOR).length !== 2) throw new Error('jsQR 原始碼與預期不同，無法加上 Structured Append 支援；請確認 jsqr 版本為 1.4.0。');
  return normalized.replace(ANCHOR, PATCH);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = fileURLToPath(new URL('../node_modules/jsqr/dist/jsQR.js', import.meta.url));
  const source = readFileSync(file, 'utf8');
  const patched = patchJsQR(source);
  if (patched !== source) writeFileSync(file, patched);
  console.log(patched === source ? 'jsQR: Structured Append 已支援' : 'jsQR: 已加上 Structured Append 支援');
}
