// Shared by both A4 generators; no barcode code here, so the management lists load without JsBarcode.
import type { PDFDocument, PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { asset } from './model';
export const mm = (value: number) => value * 72 / 25.4;
/**
 * Embeds Noto Sans TC (the static 400 weight of a variable file) in full: fontkit's CJK subsets keep the text layer
 * but render blank glyphs (re-checked 2026-10-10 with the static font), so each PDF stays ~4.4 MB.
 */
export async function embedNoto(document: PDFDocument, notoBytes?: Uint8Array): Promise<PDFFont> {
  document.registerFontkit({ ...fontkit, create(bytes: Uint8Array) { const font = fontkit.create(bytes) as any; return font.variationAxes?.wght ? font.getVariation({ wght: 400 }) : font; } });
  const bytes = notoBytes ?? new Uint8Array(await (await fetch(asset('fonts/NotoSansTC-PDF.ttf'))).arrayBuffer());
  return document.embedFont(bytes, { subset: false, features: { locl: false } });
}
// Breaks between words, between CJK characters or after "/", so "3ML" or
// "(黃盒)" is not split; a run wider than the column still breaks by character.
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const fits = (value: string) => font.widthOfTextAtSize(value, size) <= width;
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const tokens = paragraph.match(/\s+|\p{Script=Han}[)\]）】」』,，、。;；:：%]*|[^\s\p{Script=Han}]+?(?:\/|(?=[\s\p{Script=Han}]|$))/gu) ?? [];
    for (let i = 0; i < tokens.length - 1; i++) { const open = tokens[i].match(/[([（【「『]+$/); if (open) { tokens[i] = tokens[i].slice(0, -open[0].length); tokens[i + 1] = open[0] + tokens[i + 1]; } }
    // Keep short bracket groups such as (管4) or (黃盒) on one line.
    for (let i = 0; i < tokens.length; i++) {
      if (!/^[([（【]/.test(tokens[i]) || /[)\]）】]/.test(tokens[i])) continue;
      let j = i, group = tokens[i];
      while (j + 1 < tokens.length && !/[)\]）】]/.test(group) && Array.from(group + tokens[j + 1]).length <= 8 && tokens[j + 1].trim()) group += tokens[++j];
      if (/[)\]）】]/.test(group)) tokens.splice(i, j - i + 1, group);
    }
    let current = '';
    for (const token of tokens) {
      if (fits(current + token)) { current += token; continue; }
      if (current.trim()) { lines.push(current.trimEnd()); current = ''; }
      if (!token.trim()) continue;
      for (const char of Array.from(token)) { if (current && !fits(current + char)) { lines.push(current); current = ''; } current += char; }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}
