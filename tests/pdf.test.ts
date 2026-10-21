import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {generatePDF,mm,type RowHeight} from '../src/pdf';import {emptyBox,inventoryWarning,type InventoryRow} from '../src/model';
import {pdfText} from './pdf-text';
const font=new Uint8Array(readFileSync('public/assets/fonts/NotoSansTC-PDF.ttf'));
// One-line names keep every row at the selected minimum height.
const rows=(n:number)=>Array.from({length:n},(_,i):InventoryRow=>({id:`r${i}`,page:1,sku:String(i+1).padStart(6,'0'),rawName:'品項',name:'品項',location:'A01',bookQty:'1',
  boxes:{sku:emptyBox,rawName:emptyBox,location:emptyBox,bookQty:emptyBox},confidence:{sku:100,rawName:100,location:100,bookQty:100},issues:[],reviewed:true,attention:false}));
const pages=async(n:number,rowHeight:RowHeight)=>(await generatePDF(rows(n),{storeName:'測試門市',sortMode:'sku',rowHeight},font)).pageCount;
test('a page holds 11 rows at 22.6 mm, 9 at 25.8 mm and 8 at 29 mm',async()=>{
  for(const [rowHeight,perPage] of [[22.6,11],[25.8,9],[29,8]] as const){
    assert.equal(await pages(perPage,rowHeight),1,`${perPage} rows of ${rowHeight} mm fit one page`);
    assert.equal(await pages(perPage+1,rowHeight),2,`${perPage+1} rows of ${rowHeight} mm need a second page`);
  }
});
test('old source dates warn only on the first PDF page, preserving all rows and keeping the warning above the table',async()=>{
  const warning=inventoryWarning([{printed:{y:2026,m:10,d:18}},{}],{y:2026,m:10,d:21});
  const result=await generatePDF(rows(21),{storeName:'測試門市',sortMode:'sku',rowHeight:22.6,source:'多份來源・校對版本 5',warning},font);
  assert.equal(result.barcodeCount,21);
  const pages=await pdfText(result.bytes);assert.equal(pages.length,result.pageCount);assert.ok(pages.length>1);
  for(const [index,page] of pages.entries()){
    const text=page.text.replace(/\s/g,'');
    for(const phrase of ['【提示】','2026/10/18','距今3日','庫存可能與現況不符','【提醒】','未能讀取列印日期','校對版本5'])assert.equal(text.includes(phrase),index===0,phrase);
    assert.ok(Math.abs(page.width-mm(210))<.01&&Math.abs(page.height-mm(297))<.01);
  }
  assert.deepEqual(pages.flatMap(page=>page.text.match(/^\d{6}$/gm)??[]),rows(21).map(row=>row.sku));
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc=await pdfjs.getDocument({data:result.bytes.slice(),isEvalSupported:false,verbosity:0,cMapUrl:'node_modules/pdfjs-dist/cmaps/',cMapPacked:true}).promise;
  try{
    for(let n=1;n<=doc.numPages;n++){
      const page=await doc.getPage(n);const content=await page.getTextContent();
      const text=content.items.flatMap(item=>'str' in item?[item]:[]);
      const header=text.find(item=>item.str==='條碼 / 六編碼')!;
      if(n>1){assert.ok(Math.abs(header.transform[5]-mm(266.7))<.01,'later pages reclaim warning space');continue;}
      const warningStart=text.find(item=>item.str.includes('【提示】'))!;
      assert.ok(Math.abs(warningStart.transform[0]-11.5)<.01,'warning uses enlarged 11.5 pt text');
      const operators=await page.getOperatorList();
      assert.ok(operators.fnArray.some((op,i)=>op===pdfjs.OPS.setTextRenderingMode&&operators.argsArray[i][0]===2),'warning glyphs use fill and outline for bold weight');
      const warningLines=text.filter(item=>item.str.trim()&&item.transform[5]<=warningStart.transform[5]&&item.transform[5]>header.transform[5]);
      assert.ok(warningLines.length>=2,'stale warning and unreadable-date reminder use separate lines');
      assert.ok(Math.min(...warningLines.map(item=>item.transform[5]))>header.transform[5]+9,'warning does not overlap the header');
    }
  }finally{await doc.destroy();}
});
test('a source only two days old keeps the ordinary 11-row layout with no warning',async()=>{
  const warning=inventoryWarning([{printed:{y:2026,m:10,d:19}}],{y:2026,m:10,d:21});
  const result=await generatePDF(rows(11),{storeName:'測試門市',sortMode:'sku',rowHeight:22.6,warning},font);
  assert.equal(result.pageCount,1);
  assert.ok(!(await pdfText(result.bytes))[0].text.includes('【提示】'));
});

test('negative counts and the ordinary footer are omitted, while titles, columns and page numbers remain',async()=>{
  const input=rows(22);input[0].bookQty='-2';
  const result=await generatePDF(input,{storeName:'測試門市',sortMode:'sku',rowHeight:22.6,source:'來源 sample.pdf · 輸出 22 筆'},font);
  const pages=await pdfText(result.bytes);assert.equal(pages.length,2);
  for(const [i,page] of pages.entries()){
    const text=page.text.replace(/\s/g,'');
    for(const phrase of ['負數帳量','略過帳量0','A4原尺寸','最低列高','實量請手寫'])assert.ok(!text.includes(phrase),phrase);
    for(const phrase of ['門市庫存盤點表','條碼/六編碼',`${i+1}/2`])assert.ok(text.includes(phrase),phrase);
    assert.equal(text.includes('sample.pdf'),i===0);
  }
  assert.deepEqual(pages.flatMap(page=>page.text.match(/^\d{6}$/gm)??[]),input.map(row=>row.sku));
});

test('the requested ten-day warning fits one bold line inside the printable width',async()=>{
  const warning=inventoryWarning([{printed:{y:2026,m:10,d:11}}],{y:2026,m:10,d:21});
  assert.equal(warning,'【提示】來源最早列印於 2026/10/11（距今 10 日）；庫存可能與現況不符，建議重新列印簡表再輸入。');
  const result=await generatePDF(rows(21),{storeName:'測試門市',sortMode:'sku',rowHeight:22.6,warning},font);
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc=await pdfjs.getDocument({data:result.bytes.slice(),isEvalSupported:false,verbosity:0,cMapUrl:'node_modules/pdfjs-dist/cmaps/',cMapPacked:true}).promise;
  try{
    const page=await doc.getPage(1);const content=await page.getTextContent();
    const text=content.items.flatMap(item=>'str' in item?[item]:[]);
    const header=text.find(item=>item.str==='條碼 / 六編碼')!;
    const start=text.find(item=>item.str.includes('【提示】'))!;
    const lines=text.filter(item=>item.str.trim()&&item.transform[5]<=start.transform[5]&&item.transform[5]>header.transform[5]);
    assert.equal(lines.length,1,'the complete warning takes exactly one line');
    assert.equal(lines[0].str,warning);
    assert.ok(lines[0].transform[4]+lines[0].width<=mm(200)-.15,'including the bold stroke, the line stays inside the right margin');
    assert.ok(Math.abs(lines[0].transform[0]-11.5)<.01);
    const ops=await page.getOperatorList();
    assert.ok(ops.fnArray.some((op,i)=>op===pdfjs.OPS.setTextRenderingMode&&ops.argsArray[i][0]===2));
    for(let n=2;n<=doc.numPages;n++)assert.ok(!(await (await doc.getPage(n)).getTextContent()).items.some(item=>'str' in item&&item.str.includes('【提示】')));
  }finally{await doc.destroy();}
});
