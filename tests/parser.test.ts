import test from 'node:test';import assert from 'node:assert/strict';
import {detectLayout,continuationValid,extractRows,LOCATION_OVERFLOW,POOR_NAME,POOR_LOCATION,splitTrailingQuantity,type Reading,type Span} from '../src/parser';
const word=(text:string,x:number):Span=>({text,x0:x,x1:x+35,y0:90,y1:105,confidence:96});
const headers=['商品代號','名稱','國際條碼','簡稱','儲位','庫存量','寄庫量'].map((s,i)=>word(s,[5,95,395,665,745,825,880][i]));
const read=(lines:Span[]):Reading=>({text:lines.map(l=>l.text).join('\n'),lines,words:lines,confidence:95});
test('recognition depends on headings and order, never store name',()=>{
  const a=detectLayout(read(headers),1000,700);const b=detectLayout(read([word('任何新店名',250),...headers]),1000,700);assert.deepEqual(a,b);assert.ok(a);
  assert.equal(detectLayout(read([word('發票',10),word('統編',50)]),1000,700),null);
  assert.equal(detectLayout(read(headers.filter(h=>h.text!=='國際條碼')),1000,700),null);
});
test('header retries complement the broad pass without erasing valid headings',()=>{
  const broad=read(headers.filter(h=>h.text!=='庫存量'));
  const band=read(headers.map(h=>h.text==='商品代號'?{...h,text:'而品號'}:h));
  assert.equal(detectLayout(broad,1000,700),null);
  assert.equal(detectLayout(band,1000,700),null);
  const layout=detectLayout(broad,1000,700,[band]);
  assert.ok(layout);
  assert.ok(layout.bookQty[1]<880/1000,'inventory column must end before consigned quantity');
  assert.equal(detectLayout(read(headers.filter(h=>h.text!=='商品代號')),1000,700,[band]),null);
  const otherLine=read(band.words.map(h=>({...h,y0:h.y0+180,y1:h.y1+180})));
  assert.equal(detectLayout(broad,1000,700,[otherLine]),null,'headings on different lines must not combine');
});
test('row assignment joins a wrapped name, keeps quantity column and exposes numeric mismatch',()=>{
  const layout=detectLayout(read(headers),1000,700)!;
  const line=(text:string,y:number):Span=>({text,x0:0,x1:40,y0:y,y1:y+10,confidence:95});
  const codes=read([line('000001',140),line('000002',180)]);
  const names=read([line('C-&10粒/盒FIRST',140),line('NAME0.5MG(管4)',155),line('C-&10粒/盒SECOND',180)]);
  const rows=extractRows(1,1000,700,layout,{codesA:codes,codesB:codes,names,locations:read([line('L2',140),line('L10',180)]),qtyA:read([line('1,240',140),line('0',180)]),qtyB:read([line('4,240',140),line('0',180)])});
  assert.equal(rows.length,2);assert.equal(rows[0].name,'FIRST NAME0.5MG(管4)');assert.ok(rows[0].issues.includes('庫存量兩次辨識不一致'));assert.equal(rows[1].bookQty,'0');
  assert.ok(continuationValid(rows,'庫別:'));assert.equal(continuationValid([],'收據'),false);
});
test('final product retains wrapped name lines without consuming quantity totals or footer',()=>{
  const layout=detectLayout(read(headers),1000,700)!;
  const line=(text:string,y:number):Span=>({text,x0:0,x1:40,y0:y,y1:y+10,confidence:95});
  const codes=read([line('000001',140),line('000002',180)]);
  const names=read([line('FIRST',140),line('SECOND (針筒裝)(',180),line('盒)',210),line('報表編號',235)]);
  const qty=read([line('4',140),line('1',180),line('5',220)]);
  const rows=extractRows(1,1000,700,layout,{codesA:codes,codesB:codes,names,locations:read([]),qtyA:qty,qtyB:qty});
  assert.equal(rows[1].rawName,'SECOND(針筒裝)(盒)');
  assert.equal(rows[1].bookQty,'1');
  assert.ok(rows[1].boxes.rawName.height>rows[1].boxes.bookQty.height);
});
test('a code missed by the first pass is recovered from the second instead of merging two rows',()=>{
  const layout=detectLayout(read(headers),1000,700)!;
  const line=(text:string,y:number):Span=>({text,x0:0,x1:40,y0:y,y1:y+10,confidence:95});
  const names=read([line('C-&10粒/盒FIRST',140),line('C-&10粒/盒SECOND',180),line('C-&10粒/盒THIRD',220)]);
  const qty=read([line('1',140),line('2',180),line('3',220)]);
  const rows=extractRows(1,1000,700,layout,{codesA:read([line('000001',140),line('000003',220)]),codesB:read([line('000001',140),line('000002',180),line('000003',220)]),names,locations:read([]),qtyA:qty,qtyB:qty});
  assert.deepEqual(rows.map(r=>[r.sku,r.name,r.bookQty]),[['000001','FIRST','1'],['000002','SECOND','2'],['000003','THIRD','3']]);
  assert.ok(rows[1].issues.some(i=>i.includes('第二次辨識')));
});
test('two quantities inside one row are flagged as a possible merge, never concatenated',()=>{
  const layout=detectLayout(read(headers),1000,700)!;
  const line=(text:string,y:number):Span=>({text,x0:0,x1:40,y0:y,y1:y+10,confidence:95});
  const codes=read([line('000001',140),line('000003',220)]);
  const qty=read([line('1',140),line('2',180),line('3',220)]);
  const rows=extractRows(1,1000,700,layout,{codesA:codes,codesB:codes,names:read([line('FIRST',140),line('SECOND',180),line('THIRD',220)]),locations:read([]),qtyA:qty,qtyB:qty});
  const merged=rows.find(r=>r.sku==='000003')!;
  assert.notEqual(merged.bookQty,'23');assert.ok(merged.issues.some(i=>i.includes('可能合併')));
});
test('a trailing wide OCR gap isolates the quantity without merging an overflowed location tail',()=>{
  const spans=(left:string,right:string,gap:number,base=100):Span[]=>[
    {text:left,x0:base,x1:base+left.length*8,y0:140,y1:160,confidence:95},
    {text:right,x0:base+left.length*8+gap,x1:base+left.length*8+gap+right.length*8,y0:140,y1:160,confidence:95},
  ];
  assert.equal(splitTrailingQuantity(spans('-2','0',20))?.quantity,'0');
  assert.equal(splitTrailingQuantity(spans('架2-5現8-2','0',20))?.quantity,'0');
  assert.equal(splitTrailingQuantity(spans('1','240',8)),undefined);
  assert.equal(splitTrailingQuantity([{text:'0',x0:100,x1:108,y0:140,y1:160,confidence:95}])?.quantity,undefined);
  const layout=detectLayout(read(headers),1000,700)!;const line=(text:string,y:number):Span=>({text,x0:0,x1:40,y0:y,y1:y+10,confidence:95});
  const overflow=spans('架2-5現8-2','0',20,740);const qty:Reading={text:'架2-5現8-2 0',lines:overflow,words:overflow,confidence:95};
  const rows=extractRows(1,1000,700,layout,{codesA:read([line('000001',140)]),codesB:read([line('000001',140)]),names:read([line('FIRST',140)]),locations:read([]),qtyA:qty,qtyB:qty});
  assert.equal(rows[0].bookQty,'0');assert.ok(rows[0].issues.includes(LOCATION_OVERFLOW));assert.ok(rows[0].boxes.bookQty.x>layout.bookQty[0]);
});
test('a report line such as 庫別: 0026 in the code column is not a product row',()=>{
  const layout=detectLayout(read(headers),1000,700)!;
  const line=(text:string,y:number):Span=>({text,x0:0,x1:40,y0:y,y1:y+10,confidence:95});
  const codes=read([line('0026',120),line('000001',140)]);const qty=read([line('5',140)]);
  const rows=extractRows(1,1000,700,layout,{codesA:codes,codesB:codes,names:read([line('FIRST',140)]),locations:read([]),qtyA:qty,qtyB:qty});
  assert.deepEqual(rows.map(r=>r.sku),['000001']);
});
test('name/location notes only for clearly poor readings (name < 60, location < 40)',()=>{
  const layout=detectLayout(read(headers),1000,700)!;
  const line=(text:string,y:number,confidence:number):Span=>({text,x0:0,x1:40,y0:y,y1:y+10,confidence});
  const codes=read([line('000001',140,95),line('000002',180,95)]);const qty=read([line('5',140,95),line('6',180,95)]);
  const rows=extractRows(1,1000,700,layout,{codesA:codes,codesB:codes,names:read([line('FIRST',140,70),line('SECOND',180,45)]),locations:read([line('L2',140,55),line('L3',180,30)]),qtyA:qty,qtyB:qty});
  assert.deepEqual(rows[0].issues.filter(i=>i===POOR_NAME||i===POOR_LOCATION),[]);
  assert.deepEqual(rows[1].issues.filter(i=>i===POOR_NAME||i===POOR_LOCATION),[POOR_NAME,POOR_LOCATION]);
  assert.ok(rows.every(r=>!r.issues.some(i=>/^(名稱|儲位)辨識信心偏低$/.test(i))));
});
