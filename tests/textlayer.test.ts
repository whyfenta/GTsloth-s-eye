import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {extractTextPage,textLayer,type TextItem,type TextPage} from '../src/textlayer';
import {dropZeroRows,validationErrors,type InventoryRow} from '../src/model';
// Synthetic system-printed report: [text, x, y] in upright page pixels (1000 x 700).
const cells:[string,number,number][]=[
  ['26北-測試店',400,20],['庫存簡表',420,40],
  ['商品代號',5,90],['名稱',95,90],['國際條碼',395,90],['簡稱',665,90],['儲位',745,90],['庫存量',825,90],['寄庫量',880,90],
  ['庫別: 0026',5,115],
  ['000001',5,140],['C-&10粒/盒FIRST 測試錠0.5MG(管4)',95,140],['4710000000001',395,140],['A-裕利(葛蘭素',645,140],['4R54@',745,140],['1,240',830,140],['0',890,140],
  ['000002',5,180],['避光C-SECOND 測試水',95,180],['4710000000002',395,180],['A-測試',665,180],['',745,180],['7',840,180],['0',890,180],
  ['0026庫別小計:',600,230],['報表編號: w_imlcl_1',5,680],['頁次 1 of 1',800,680],
];
const weight=(s:string)=>Array.from(s).reduce((n,c)=>n+(c.codePointAt(0)!>=0x2e80?2:1),0);
const W=1000,H=700,size=10;
// Upright page: pdf.js viewport flips y (PDF space is y-up).
const upright:TextPage={viewport:[1,0,0,-1,0,H],width:W,height:H,hasImages:false,items:cells.map(([str,x,y])=>({str,width:weight(str)*size/2,transform:[size,0,0,size,x,H-y]}))};
// Same report printed sideways on a portrait page (text runs upwards), as Bullzip's 90° pages.
const sideways:TextPage={viewport:[1,0,0,-1,0,W],width:H,height:W,hasImages:false,items:cells.map(([str,x,y]):TextItem=>{
  const vx=y,vy=W-x; return {str,width:weight(str)*size/2,transform:[0,size,-size,0,vx,W-vy]};
})};
test('text layer rows are exact: no OCR doubts, footer and subtotal excluded, neighbour column overflow kept out',()=>{
  const result=extractTextPage(1,upright)!;assert.ok(result);
  assert.equal(result.report.mode,'text');assert.equal(result.report.storeName,'26北-測試店');
  assert.deepEqual(result.rows.map(r=>[r.sku,r.name,r.location,r.bookQty]),[['000001','FIRST測試錠0.5MG(管4)','4R54@','1240'],['000002','SECOND測試水','','7']]);
  assert.deepEqual(result.rows[0].issues,[]);assert.deepEqual(result.rows[1].issues,[],'a blank location is not a warning');
});
test('whole text runs stay in their starting columns even when their glyphs cross a boundary',()=>{
  const items=upright.items.map(item=>({...item}));
  const location=items.find(item=>item.str==='4R54@')!;location.str='架2-5現8-2';location.width=70;
  const abbreviation=items.find(item=>item.str==='A-裕利(葛蘭素')!;abbreviation.str='A-大昌(賽諾菲';abbreviation.width=110;
  const name=items.find(item=>item.str.includes('FIRST'))!;name.str='C-&10粒/盒A VERY LONG PRODUCT NAME測試錠0.5MG(管4)';name.width=280;
  const result=extractTextPage(1,{...upright,items})!;
  assert.equal(result.rows[0].location,'架2-5現8-2');assert.equal(result.rows[0].bookQty,'1240');
  assert.equal(result.rows[0].name,'A VERY LONG PRODUCT NAME測試錠0.5MG(管4)');assert.ok(!result.rows[0].location.includes('賽諾菲'));
});
test('sideways text is turned upright with the same rows',()=>{
  const layer=textLayer(sideways);assert.equal(layer.rotation,90);assert.equal(layer.width,W);assert.equal(layer.height,H);
  const a=extractTextPage(1,upright)!;const b=extractTextPage(1,sideways)!;
  assert.deepEqual(b.rows.map(r=>[r.sku,r.name,r.location,r.bookQty]),a.rows.map(r=>[r.sku,r.name,r.location,r.bookQty]));assert.equal(b.report.rotation,90);
});
test('a text layer built by the caller gives the same result as rebuilding it',()=>{
  for(const page of [upright,sideways])assert.deepEqual(extractTextPage(1,page,undefined,textLayer(page)),extractTextPage(1,page));
});
test('printed date metadata survives upright, sideways and headerless continuation pages',()=>{
  const printed='報表編號: w_im1c1_1 列印時間：2026/10/18 09:00:00';
  const dateCells:[string,number,number][]=[...cells,[printed,5,660]];
  const dated:TextPage={...upright,items:dateCells.map(([str,x,y])=>({str,width:weight(str)*size/2,transform:[size,0,0,size,x,H-y]}))};
  const turned:TextPage={...sideways,items:dateCells.map(([str,x,y])=>({str,width:weight(str)*size/2,transform:[0,size,-size,0,y,x]}))};
  const first=extractTextPage(1,dated)!;
  assert.deepEqual(first.report.printed,{y:2026,m:10,d:18});
  assert.deepEqual(extractTextPage(1,turned)!.report.printed,first.report.printed);
  const headings=['商品代號','名稱','國際條碼','簡稱','儲位','庫存量','寄庫量'];
  const continuation={...dated,items:dated.items.filter(item=>!headings.includes(item.str))};
  assert.deepEqual(extractTextPage(2,continuation,first.layout)!.report.printed,first.report.printed);
  assert.equal(extractTextPage(1,upright)!.report.printed,undefined,'no guessed creation date');
});
test('pages with images (scans, incl. hidden scanner OCR) or without a table fall back to OCR',()=>{
  assert.equal(extractTextPage(1,{...upright,hasImages:true}),undefined);
  assert.equal(extractTextPage(1,{...upright,items:[]}),undefined);
  assert.equal(extractTextPage(1,{...upright,items:upright.items.filter(i=>!['國際條碼','庫存量'].includes(i.str))}),undefined);
});
// Private real files stay local: INVENTORY_TEXT_PDF (system-printed) / INVENTORY_SCAN_PDF (scanned).
async function readPages(file:string){
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const images=new Set([pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject,pdfjs.OPS.paintImageMaskXObject]);
  const doc=await pdfjs.getDocument({data:new Uint8Array(fs.readFileSync(file)),verbosity:0}).promise;const pages:TextPage[]=[];
  for(let n=1;n<=doc.numPages;n++){const page=await doc.getPage(n);const vp=page.getViewport({scale:300/72});const ops=await page.getOperatorList();const content=await page.getTextContent();
    pages.push({viewport:vp.transform,width:Math.ceil(vp.width),height:Math.ceil(vp.height),hasImages:ops.fnArray.some(f=>images.has(f)),items:content.items.flatMap((i:any)=>'str' in i?[{str:i.str,transform:i.transform,width:i.width}]:[])});}
  return pages;
}
test('real system-printed PDF reads entirely from text',async t=>{
  const file=process.env.INVENTORY_TEXT_PDF;if(!file||!fs.existsSync(file))return t.skip('Set INVENTORY_TEXT_PDF to the private system-printed sample.');
  let previous;const rows=[];for(const [i,page] of (await readPages(file)).entries()){const r=extractTextPage(i+1,page,previous);assert.ok(r,`page ${i+1}`);previous=r.layout??previous;rows.push(...r.rows);}
  assert.ok(rows.length>0);assert.ok(rows.every(r=>/^\d{6}$/.test(r.sku)&&/^-?\d+(\.\d+)?$/.test(r.bookQty)));
  assert.ok(rows.every(r=>r.issues.length===0),'exact text raises no notes');
});
test('0015-09 text layer keeps corrected fields and safely removes only recognised zero quantities',async t=>{
  const file=process.env.INVENTORY_0015_PDF;if(!file||!fs.existsSync(file))return t.skip('Set INVENTORY_0015_PDF to the private 0015-09 template.');
  let previous;const rows:InventoryRow[]=[];for(const [index,page] of (await readPages(file)).entries()){const result=extractTextPage(index+1,page,previous);assert.ok(result,`page ${index+1}`);previous=result.layout??previous;rows.push(...result.rows);}
  assert.equal(rows.length,4949);assert.deepEqual(rows.flatMap(validationErrors),[]);
  const expected:Record<string,[string,string]>={
    '000313':['架2-5現8-2','0'],'000557':['外3-3現7-8','2'],'000866':['S32現10-7','199'],'006605':['現8-2安5-1','0'],'103730':['A16現1-10','2245'],
    '108490':['Z01現10-8','396'],'112865':['T07現10-5','111'],'113328':['C1盒1現3-1','4551'],'113739':['吸3現13-4','1'],'114150':['架0-2現安','0'],
    '119460':['N1盒1現8-3','4986'],'121144':['鼻3現14-8','14'],'121554':['T9現10-3','147'],'121776':['藥膏3現7-8','1'],'125451':['T17現10-2','1272'],
    '127205':['吸4現13-6','2'],'135425':['藥膏1現7-6','3'],'144184':['現1-8安1-3','0'],'188856':['冰-合作診所','0'],'192314':['冰-合作診所','0'],
  };
  for(const [sku,[location,bookQty]] of Object.entries(expected)){const row=rows.find(row=>row.sku===sku);assert.deepEqual([row?.location,row?.bookQty],[location,bookQty],sku);}
  assert.equal(rows.find(row=>row.sku==='181524')?.location,'管2-5');
  const {kept,skipped}=dropZeroRows(rows);assert.equal(kept.length,1388);assert.equal(skipped.length,3561);assert.ok(kept.every(row=>row.issues.length===0));
});
test('0015-09 stock-only companion retains its 1,361 positive rows',async t=>{
  const file=process.env.INVENTORY_0015_STOCK_PDF;if(!file||!fs.existsSync(file))return t.skip('Set INVENTORY_0015_STOCK_PDF to the private 0015-09 stock-only PDF.');
  let previous;const rows:InventoryRow[]=[];for(const [index,page] of (await readPages(file)).entries()){const result=extractTextPage(index+1,page,previous);assert.ok(result,`page ${index+1}`);previous=result.layout??previous;rows.push(...result.rows);}
  const {kept,skipped}=dropZeroRows(rows);assert.equal(kept.length,1361);assert.equal(skipped.length,0);assert.ok(kept.every(row=>row.issues.length===0));
});
test('cold-storage template keeps its real table location header, not the report-sort label',async t=>{
  const file=process.env.INVENTORY_COLD_PDF;if(!file||!fs.existsSync(file))return t.skip('Set INVENTORY_COLD_PDF to the private cold-storage template.');
  const pages=await readPages(file);assert.equal(pages.length,1);const result=extractTextPage(1,pages[0]);assert.ok(result);
  assert.equal(result.report.mode,'text');assert.equal(result.rows.length,14);
  assert.deepEqual(result.rows.map(r=>[r.sku,r.location,r.bookQty]),[
    ['160068','冰(綠)','1'],['154563','冰1右','14'],['154348','冰1右黃','1'],['106606','冰1左黃','10'],['139261','冰1左綠','28'],['123450','冰2右紅','2'],['120875','冰2右黃','2'],['129852','冰2右藍','6'],['161573','冰2左','25'],['129867','冰2左橘','14'],['119631','冰3','10'],['122722','冰3右','5'],['143767','冰3右','30'],['158387','冰4','3'],
  ]);
  assert.ok(result.rows.every(r=>r.issues.length===0));
});
test('real scanned PDF is never read as text',async t=>{
  const file=process.env.INVENTORY_SCAN_PDF;if(!file||!fs.existsSync(file))return t.skip('Set INVENTORY_SCAN_PDF to a private scanned sample.');
  for(const [i,page] of (await readPages(file)).entries()){assert.equal(page.hasImages,true);assert.equal(extractTextPage(i+1,page),undefined);}
});
