/**
 * QR Structured Append: one message printed as 2 to 16 QR codes, each starting with its index, the number of codes and a parity
 * byte, the same in all of them. Some hospitals print a prescription with many drugs this way, cutting the text wherever the
 * first code is full, even inside a drug's fields. scripts/patch-jsqr.mjs makes jsQR give the header as a chunk.
 */
export interface QRPart { index: number; total: number; parity: number }
export function structuredAppend(chunks: readonly unknown[]): QRPart | undefined {
  const chunk = chunks.find(item => (item as { type?: string }).type === 'structuredappend') as QRPart | undefined;
  return chunk && chunk.total > 1 && chunk.index < chunk.total ? { index: chunk.index, total: chunk.total, parity: chunk.parity } : undefined;
}
/**
 * Collects the codes of one message, read in any order and any number of times. add gives the joined bytes once every code is in;
 * a code of another message (another parity or number of codes) starts over with it. The parity only tells messages apart: it
 * should be the XOR of the message's bytes, but encoders take them in different character sets (UTF-8 here, Shift-JIS in some),
 * and each code has its own error correction.
 */
export class QRParts {
  private parts: (Uint8Array | undefined)[] = [];
  private key = '';
  /** How many codes of the message are in, and how many it has; 0 of 0 before the first. */
  get progress() { return { read: this.parts.filter(Boolean).length, total: this.parts.length }; }
  add(bytes: Uint8Array, part: QRPart): Uint8Array | undefined {
    const key = `${part.total}:${part.parity}`;
    if (key !== this.key) { this.key = key; this.parts = Array.from({ length: part.total }, () => undefined); }
    this.parts[part.index] = bytes;
    if (this.parts.some(item => !item)) return undefined;
    const joined = new Uint8Array(this.parts.reduce((sum, item) => sum + item!.length, 0));
    let at = 0;
    for (const item of this.parts) { joined.set(item!, at); at += item!.length; }
    this.key = '';
    this.parts = [];
    return joined;
  }
}
