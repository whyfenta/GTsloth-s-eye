import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {PDFDocument,PDFDict,PDFName} from 'pdf-lib';
import {generateListPDF,type ListSpec} from '../src/management-pdf';
import {pdfText} from './pdf-text';
const font=new Uint8Array(readFileSync('public/assets/fonts/NotoSansTC-PDF.ttf'));
const spec=(rows:string[][]):ListSpec=>({title:'安全量調整及採購建議清單',meta:['26測試店 | 統計期間 2026/06/16～2026/10/15（4 個月）','來源：測試 | 校對版本 3'],note:'A = 合計次數 ÷ 統計月數。',empty:'沒有符合的品項。',
  columns:[{label:'六編碼',width:18},{label:'品名',width:68},{label:'現有庫存量',width:22,align:'right'},{label:'調劑頻率(/月)',width:24,align:'right'},{label:'均月銷',width:18,align:'right'},{label:'建議安全量',width:20,align:'right'},{label:'待採量',width:20,align:'right'}],rows});
test('A4 pages repeat title, headings and page number; metadata appears on the first page only; long names wrap and a row is never split',async()=>{
  const long='很長的名稱'.repeat(12)+' EXTRA LONG PRODUCT NAME 500MG(管4)';
  const rows=Array.from({length:70},(_,i)=>[String(i+1).padStart(6,'0'),i%7===0?long:'EZETROL怡妥錠10MG','1,990','41.25','1,072.5','3,754','1,764']);
  const result=await generateListPDF(spec(rows),font);const pages=await pdfText(result.bytes);
  assert.equal(result.pageCount,pages.length);assert.ok(pages.length>=2);
  for(const [i,page] of pages.entries()){
    for(const meta of ['26測試店','2026/06/16～2026/10/15','校對版本 3'])assert.equal(page.text.includes(meta),i===0);
    assert.equal(Math.round(page.width),595);assert.equal(Math.round(page.height),842);
    for(const text of ['安全量調整及採購建議清單','品名','調劑頻率(/月)','建議安全量','待採量',`${i+1} / ${pages.length}`])assert.ok(page.text.includes(text),`page ${i+1}: ${text}`);
  }
  const codes=pages.flatMap(page=>page.text.match(/^\d{6}$/gm)??[]);
  assert.deepEqual(codes,rows.map(r=>r[0]),'every code once, in order, none split across pages');
  assert.ok(pages[0].text.includes('很長的名稱很長的名稱'));
});
test('tail rows follow the list under a full-width heading, which never ends a page alone',async()=>{
  const rows=Array.from({length:55},(_,i)=>[String(i+1).padStart(6,'0'),'EZETROL怡妥錠10MG','1,990','41.25','1,072.5','3,754','1,764']);
  const tail=[['900001','自費品一','4','','','',''],['900002','自費品二','2','','','','']];
  for(const count of [rows.length,0]){
    const result=await generateListPDF({...spec(rows.slice(0,count)),tail:{heading:'以下品項偵測應為自費品，請過目。',rows:tail}},font);const pages=await pdfText(result.bytes);
    assert.deepEqual(pages.flatMap(page=>page.text.match(/^\d{6}$/gm)??[]),[...rows.slice(0,count),...tail].map(r=>r[0]));
    const at=pages.findIndex(page=>page.text.includes('以下品項偵測應為自費品'));assert.ok(at>=0);assert.ok(pages[at].text.includes('900001'),'heading kept with its first row');
    assert.equal(result.rowCount,count);
  }
});
test('a list without rows still prints a page that says why',async()=>{
  const result=await generateListPDF(spec([]),font);const [page]=await pdfText(result.bytes);
  assert.equal(result.pageCount,1);assert.ok(page.text.includes('沒有符合的品項。'));assert.ok(page.text.includes('1 / 1'));
});
test('column widths must fill the 190 mm table',async()=>{
  await assert.rejects(generateListPDF({...spec([]),columns:[{label:'六碼',width:20}]},font),/190 mm/);
});
test('alert cells print in red Helvetica-Bold; only numbers can be marked',async()=>{
  const rows=[['000001','品一','5,000','10','100','350','0'],['000002','品二','100','10','100','350','250']];
  const result=await generateListPDF({...spec(rows),alerts:[[false,false,true,false,false,false,false],[]]},font);
  const fonts=async(bytes:Uint8Array)=>(await PDFDocument.load(bytes)).context.enumerateIndirectObjects().flatMap(([,o])=>o instanceof PDFDict&&o.get(PDFName.of('BaseFont'))?[String(o.get(PDFName.of('BaseFont')))]:[]);
  assert.ok((await fonts(result.bytes)).includes('/Helvetica-Bold'));
  assert.ok((await pdfText(result.bytes))[0].text.includes('5,000'));
  await assert.rejects(generateListPDF({...spec(rows),alerts:[[false,true]]},font),/數字/);
});

test('stale warnings are enlarged and bold on the first page, above the table',async()=>{
  const warning='【警語】庫存簡表列印於 2026/10/11（距產生日 10 天），輸出結果可能失真。';
  const rows=Array.from({length:80},(_,i)=>[String(i+1).padStart(6,'0'),'測試品','1','2','3','4','5']);
  const result=await generateListPDF({...spec(rows),warning},font);
  const pages=await pdfText(result.bytes);assert.ok(pages.length>1);
  for(const [i,page] of pages.entries())assert.equal(page.text.includes('【警語】'),i===0);
  assert.deepEqual(pages.flatMap(page=>page.text.match(/^\d{6}$/gm)??[]),rows.map(r=>r[0]));
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc=await pdfjs.getDocument({data:result.bytes.slice(),isEvalSupported:false,verbosity:0,cMapUrl:'node_modules/pdfjs-dist/cmaps/',cMapPacked:true}).promise;
  try{
    const page=await doc.getPage(1);const content=await page.getTextContent();
    const text=content.items.flatMap(item=>'str' in item?[item]:[]);
    const start=text.find(item=>item.str.includes('【警語】'))!;
    const header=text.find(item=>item.str==='六編碼')!;
    assert.ok(Math.abs(start.transform[0]-11.5)<.01);
    assert.ok(start.transform[5]>header.transform[5]+11.5);
    const ops=await page.getOperatorList();assert.ok(ops.fnArray.some((op,i)=>op===pdfjs.OPS.setTextRenderingMode&&ops.argsArray[i][0]===2));
  }finally{await doc.destroy();}
});
