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
test('old source dates warn on every PDF page, preserving all rows and keeping the warning above the table',async()=>{
  const warning=inventoryWarning([{printed:{y:2026,m:10,d:18}},{}],{y:2026,m:10,d:21});
  const result=await generatePDF(rows(21),{storeName:'測試門市',sortMode:'sku',rowHeight:22.6,source:'多份來源・校對版本 5',warning},font);
  assert.equal(result.barcodeCount,21);
  const pages=await pdfText(result.bytes);assert.equal(pages.length,result.pageCount);assert.ok(pages.length>1);
  for(const page of pages){
    const text=page.text.replace(/\s/g,'');
    for(const phrase of ['【警語】','2026/10/18','距今3天','庫存可能已因調劑異動','【提醒】','未能讀取列印日期','校對版本5'])assert.ok(text.includes(phrase),phrase);
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
      const warningStart=text.find(item=>item.str.includes('【警語】'))!;
      const warningLines=text.filter(item=>item.str.trim()&&item.transform[5]<=warningStart.transform[5]&&item.transform[5]>header.transform[5]);
      assert.ok(warningLines.length>=3,'stale warning and unreadable-date reminder wrap');
      assert.ok(Math.min(...warningLines.map(item=>item.transform[5]))>header.transform[5]+9,'warning does not overlap the header');
    }
  }finally{await doc.destroy();}
});
test('a source only two days old keeps the ordinary 11-row layout with no warning',async()=>{
  const warning=inventoryWarning([{printed:{y:2026,m:10,d:19}}],{y:2026,m:10,d:21});
  const result=await generatePDF(rows(11),{storeName:'測試門市',sortMode:'sku',rowHeight:22.6,warning},font);
  assert.equal(result.pageCount,1);
  assert.ok(!(await pdfText(result.bytes))[0].text.includes('【警語】'));
});
