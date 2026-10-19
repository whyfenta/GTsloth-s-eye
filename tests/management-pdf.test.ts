import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {generateListPDF,type ListSpec} from '../src/management-pdf';
import {pdfText} from './pdf-text';
const font=new Uint8Array(readFileSync('public/assets/fonts/NotoSansTC-PDF.ttf'));
const spec=(rows:string[][]):ListSpec=>({title:'安全量調整及採購建議清單',meta:['26測試店 | 統計期間 2026/06/16～2026/10/15（4 個月）','來源：測試 | 校對版本 3'],note:'A = 合計次數 ÷ 統計月數。',empty:'沒有符合的品項。',
  columns:[{label:'六編碼',width:18},{label:'品名',width:68},{label:'現有庫存量',width:22,align:'right'},{label:'調劑頻率(/月)',width:24,align:'right'},{label:'均月銷',width:18,align:'right'},{label:'建議安全量',width:20,align:'right'},{label:'待採量',width:20,align:'right'}],rows});
test('A4 pages repeat title, store, period, headings and page number; long names wrap and a row is never split',async()=>{
  const long='很長的名稱'.repeat(12)+' EXTRA LONG PRODUCT NAME 500MG(管4)';
  const rows=Array.from({length:70},(_,i)=>[String(i+1).padStart(6,'0'),i%7===0?long:'EZETROL怡妥錠10MG','1,990','41.25','1,072.5','3,754','1,764']);
  const result=await generateListPDF(spec(rows),font);const pages=await pdfText(result.bytes);
  assert.equal(result.pageCount,pages.length);assert.ok(pages.length>=2);
  for(const [i,page] of pages.entries()){
    assert.equal(Math.round(page.width),595);assert.equal(Math.round(page.height),842);
    for(const text of ['安全量調整及採購建議清單','26測試店','2026/06/16～2026/10/15','品名','調劑頻率(/月)','建議安全量','待採量','校對版本 3',`${i+1} / ${pages.length}`])assert.ok(page.text.includes(text),`page ${i+1}: ${text}`);
  }
  const codes=pages.flatMap(page=>page.text.match(/^\d{6}$/gm)??[]);
  assert.deepEqual(codes,rows.map(r=>r[0]),'every code once, in order, none split across pages');
  assert.ok(pages[0].text.includes('很長的名稱很長的名稱'));
});
test('a list without rows still prints a page that says why',async()=>{
  const result=await generateListPDF(spec([]),font);const [page]=await pdfText(result.bytes);
  assert.equal(result.pageCount,1);assert.ok(page.text.includes('沒有符合的品項。'));assert.ok(page.text.includes('1 / 1'));
});
test('column widths must fill the 190 mm table',async()=>{
  await assert.rejects(generateListPDF({...spec([]),columns:[{label:'六碼',width:20}]},font),/190 mm/);
});
