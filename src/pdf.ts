import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import JsBarcode from 'jsbarcode';
import { asset, formatQuantity, isNegativeQuantity, sortRows, type InventoryRow, type SortMode } from './model';
export const mm = (value: number) => value * 72 / 25.4;
// Keep the 10 mm bars and 16 pt human-readable code.  These heights are not
// compressed; only the surrounding white space is 80% of template 0015-09.
export const ROW_HEIGHTS = [22.6, 25.8, 29] as const;
export type RowHeight = typeof ROW_HEIGHTS[number];
// Name 16 pt and quantity 20 pt (field feedback). The count column is left blank for handwriting.
export const PRINT = { width: 210, height: 297, margin: 10, columns: [40,60,22,25,43], moduleWidth: .4, barcodeHeight: 10,
  barcodeTopGap: 2.4, barcodeSkuBaseline: 18.65, skuSize: 16, nameSize: 16, locationSize: 10, quantitySize: 20, lineSpacing: 1.3,
  headerFill: [.84,.90,.86] as const, alternatingRowFill: [.92,.95,.93] as const };
export function barcodeBits(sku: string): string {
  if (!/^\d{6}$/.test(sku)) throw new Error('條碼只接受完整商品六編碼。');
  const target: { encodings?: { data: string }[] } = {};
  JsBarcode(target, sku, { format: 'CODE128C', displayValue: false, width: 1, height: 10, margin: 0 });
  return target.encodings!.map(e => e.data).join('');
}
// Libre Barcode maps codewords 0..94 to ASCII 32..126 and 95..106 to 195..206.
export function barcodeFontText(sku: string): string {
  if (!/^\d{6}$/.test(sku)) return '';
  const pairs = [sku.slice(0,2),sku.slice(2,4),sku.slice(4,6)].map(Number);
  const checksum = (105 + pairs.reduce((sum,n,i)=>sum+n*(i+1),0)) % 103;
  return [105,...pairs,checksum,106].map(n=>String.fromCharCode(n < 95 ? n+32 : n+100)).join('');
}
// Breaks between words, between CJK characters or after "/", so "3ML" or
// "(黃盒)" is not split; a run wider than the column still breaks by character.
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const fits = (value: string) => font.widthOfTextAtSize(value, size) <= width;
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const tokens = paragraph.match(/\s+|\p{Script=Han}[)\]）】,，、。;；:：%]*|[^\s\p{Script=Han}]+?(?:\/|(?=[\s\p{Script=Han}]|$))/gu) ?? [];
    for (let i = 0; i < tokens.length - 1; i++) { const open = tokens[i].match(/[([（【]+$/); if (open) { tokens[i] = tokens[i].slice(0, -open[0].length); tokens[i + 1] = open[0] + tokens[i + 1]; } }
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
// source identifies the exact reviewed data (file, row count, revision) printed on every page.
export type PDFOptions = { storeName: string; sortMode: SortMode; rowHeight: RowHeight; title?: string; note?: string; source?: string };
export type PDFResult = { bytes: Uint8Array; pageCount: number; barcodeCount: number };
export async function generatePDF(rows: InventoryRow[], options: PDFOptions, notoBytes?: Uint8Array): Promise<PDFResult> {
  const document = await PDFDocument.create();
  document.registerFontkit({ ...fontkit, create(bytes: Uint8Array) { const font = fontkit.create(bytes) as any; return font.variationAxes?.wght ? font.getVariation({ wght: 400 }) : font; } });
  const bytes = notoBytes ?? new Uint8Array(await (await fetch(asset('fonts/NotoSansTC-PDF.ttf'))).arrayBuffer());
  // Full embedding: fontkit's CJK subsets keep the text layer but render blank glyphs
  // (re-checked 2026-10-10 with the static font), so each PDF stays ~4.4 MB.
  const font = await document.embedFont(bytes, { subset: false, features: {locl:false} }); const numeric = await document.embedFont(StandardFonts.Courier); const numericBold = await document.embedFont(StandardFonts.CourierBold);
  document.setTitle(options.title ?? '門市庫存盤點表'); document.setAuthor('樹懶的盤點'); document.setSubject('在瀏覽器產生的 A4 盤點表');
  const ordered = sortRows(rows, options.sortMode); const widths = PRINT.columns.map(mm); const xs = [mm(10)]; for(const width of widths) xs.push(xs.at(-1)! + width);
  // Table body 264 → 15 mm (249 mm) holds 11 rows of 22.6 mm. The footer baseline sits 8 mm and the
  // title top ~10 mm from the paper edge, clear of the 3–5 mm unprintable margin of common printers.
  const top = mm(264); const bottom = mm(15); const leading = (size: number) => size * PRINT.lineSpacing;
  const prepared = ordered.map(row => {
    const nameLines = wrapText(row.name, font, PRINT.nameSize, widths[1]-mm(4));
    const locationLines = wrapText(row.location, font, PRINT.locationSize, widths[2]-mm(4));
    // A quantity is never broken across lines: one too wide at 20 pt (e.g. 12,345) is shrunk to fit.
    const qtyText = formatQuantity(row.bookQty); const qtyLines = [qtyText];
    const qtySize = Math.min(PRINT.quantitySize, (widths[3]-mm(4)) / Math.max(1e-6, numericBold.widthOfTextAtSize(qtyText, 1)));
    const textHeight = Math.max(nameLines.length*leading(PRINT.nameSize), locationLines.length*leading(PRINT.locationSize), leading(qtySize));
    const rowHeight = Math.max(mm(options.rowHeight), textHeight+mm(6));
    if (rowHeight > top-bottom) throw new Error(`商品 ${row.sku} 的名稱過長，請校對後再輸出。`);
    return { row, nameLines, locationLines, qtyLines, qtySize, rowHeight };
  });
  const groups: typeof prepared[] = []; let group: typeof prepared = []; let available = top-bottom;
  for(const item of prepared) { if(item.rowHeight > available && group.length) { groups.push(group); group=[]; available=top-bottom; } group.push(item); available-=item.rowHeight; }
  if(group.length) groups.push(group);
  const negatives = rows.filter(row => isNegativeQuantity(row.bookQty)).length;
  const order = `${options.sortMode==='sku'?'六編碼排序':'儲位排序'}${negatives?`（負數帳量 ${negatives} 筆在前）`:''}`;
  const today = new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  for(let p=0;p<groups.length;p++) {
    const page = document.addPage([mm(210),mm(297)]);
    page.drawText(options.title ?? '門市庫存盤點表',{x:mm(10),y:mm(282),size:17,font,color:rgb(.12,.23,.2)});
    const meta = `${options.storeName || '門市未填'}  |  ${today}  |  ${order}${options.source ? `  |  ${options.source}` : ''}`;
    const metaLines = wrapText(meta,font,8,mm(190));
    page.drawText(metaLines.slice(0,2).join('\n'),{x:mm(10),y:mm(277),size:8,lineHeight:9,font});
    const headerTop = top + mm(8); page.drawRectangle({x:xs[0],y:top,width:mm(190),height:mm(8),color:rgb(...PRINT.headerFill)});
    const labels = ['條碼 / 六編碼','名稱','儲位','帳量','實量'];
    labels.forEach((label,i)=>page.drawText(label,{x:xs[i]+mm(2),y:top+mm(2.7),size:9,font}));
    let y = top;
    for(const [index,item] of groups[p].entries()) {
      const {row,rowHeight,nameLines,locationLines,qtyLines,qtySize}=item; const next=y-rowHeight;
      if(index%2===1) page.drawRectangle({x:xs[1],y:next,width:xs[5]-xs[1],height:rowHeight,color:rgb(...PRINT.alternatingRowFill)});
      const bits=barcodeBits(row.sku); const barcodeWidth=bits.length*mm(.4); const bx=xs[0]+(widths[0]-barcodeWidth)/2; const by=y-mm(PRINT.barcodeTopGap+PRINT.barcodeHeight);
      for(let index=0;index<bits.length;) { if(bits[index]==='0'){index++;continue;} let end=index+1;while(bits[end]==='1')end++;
        page.drawRectangle({x:bx+index*mm(.4),y:by,width:(end-index)*mm(.4),height:mm(10),color:rgb(0,0,0)});index=end; }
      page.drawText(row.sku,{x:xs[0]+(widths[0]-numeric.widthOfTextAtSize(row.sku,PRINT.skuSize))/2,y:y-mm(PRINT.barcodeSkuBaseline),size:PRINT.skuSize,font:numeric});
      for(const [lines,column,textFont,textSize] of [[nameLines,1,font,PRINT.nameSize],[locationLines,2,font,PRINT.locationSize],[qtyLines,3,numericBold,qtySize]] as const) {
        lines.forEach((line,i)=>page.drawText(line,{x:column===3?xs[column+1]-mm(2)-textFont.widthOfTextAtSize(line,textSize):xs[column]+mm(2),y:y-mm(3)-textSize-i*leading(textSize),size:textSize,font:textFont}));
      }
      page.drawLine({start:{x:xs[0],y:next},end:{x:xs[5],y:next},thickness:.45,color:rgb(.6,.65,.62)}); y=next;
    }
    for(const x of xs) page.drawLine({start:{x,y:headerTop},end:{x,y},thickness:.45,color:rgb(.6,.65,.62)});
    page.drawLine({start:{x:xs[0],y:headerTop},end:{x:xs[5],y:headerTop},thickness:.45,color:rgb(.6,.65,.62)});
    page.drawText(options.note ?? `A4 原尺寸 100%  ·  最低列高 ${options.rowHeight} mm  ·  實量請手寫`,{x:mm(10),y:mm(8),size:7,font});
    const footer=`${p+1} / ${groups.length}`;page.drawText(footer,{x:mm(200)-numeric.widthOfTextAtSize(footer,8),y:mm(8),size:8,font:numeric});
  }
  return {bytes:await document.save(),pageCount:groups.length,barcodeCount:rows.length};
}
export function scanTestRows(): InventoryRow[] {
  return ['000001','000002','012345','100001','100002','999999'].map((sku,i)=>({
    id:`scan-${i}`,page:1,sku,rawName:'條碼掃讀測試 '+sku,name:'條碼掃讀測試 '+sku,location:'測試區',bookQty:'0',
    boxes:{sku:{x:0,y:0,width:1,height:1},rawName:{x:0,y:0,width:1,height:1},location:{x:0,y:0,width:1,height:1},bookQty:{x:0,y:0,width:1,height:1}},
    confidence:{sku:100,rawName:100,location:100,bookQty:100},issues:[],reviewed:true,attention:false,
  }));
}
