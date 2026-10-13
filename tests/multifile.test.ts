import test from 'node:test';import assert from 'node:assert/strict';
import {compareStores,emptyBox,mergeRows,sortRows,storeKey,type InventoryRow,type PageReport} from '../src/model';
import {SourceSet} from '../src/sourceset';
import {InventoryJob} from '../src/job';
import {OCREngine} from '../src/ocr';
import {POOR_NAME} from '../src/parser';
import type {TextPage} from '../src/textlayer';
const row=(sku:string,location='',bookQty='1',page=1,extra:Partial<InventoryRow>={}):InventoryRow=>({id:`${page}-${sku}-${location}`,page,sku,rawName:'品項',name:'品項',location,bookQty,boxes:{sku:emptyBox,rawName:emptyBox,location:emptyBox,bookQty:emptyBox},confidence:{sku:100,rawName:100,location:100,bookQty:100},issues:[],reviewed:true,attention:false,...extra});
test('negative book quantities print first under both orders, each group keeps its own order',()=>{
  const rows=[row('000003','L2','2'),row('000001','L10','-1'),row('000002','','4'),row('000004','','-7'),row('000005','L1','-0')];
  assert.deepEqual(sortRows(rows,'sku').map(r=>r.sku),['000001','000004','000002','000003','000005']);
  assert.deepEqual(sortRows(rows,'location').map(r=>r.sku),['000001','000004','000005','000003','000002'],'blank locations stay last inside each group; -0 is not negative');
  assert.deepEqual(sortRows([row('000002','','-1,200'),row('000001','','3')],'sku').map(r=>r.sku),['000002','000001']);
});
test('a line read equally from another file is kept once; rows of one file are never merged',()=>{
  const fileOf=(r:InventoryRow)=>r.page>=10?1:0;
  const kept=[row('000001','A01','1,240',1),row('000001','A01','1240',2)];
  assert.equal(mergeRows([],kept,fileOf).rows.length,2,'two printed lines of one report stay two records');
  const merged=mergeRows(kept,[row('000001','A 01','1240',10),row('000001','Ａ01','1240',10),row('000002','B1','3',10)],fileOf);
  assert.equal(merged.duplicates,2);assert.deepEqual(merged.conflicts,[]);
  assert.deepEqual(merged.rows.map(r=>[r.sku,r.page]),[['000001',1],['000001',2],['000002',10]]);
  // Another location is another stock line; an incomplete code is never merged.
  assert.equal(mergeRows([row('000001','A01')],[row('000001','A02','1',10)],fileOf).rows.length,2);
  assert.equal(mergeRows([row('00001','A01')],[row('00001','A01','1',10)],fileOf).rows.length,2);
});
test('the same line with another quantity in another file stays on both sides as a conflict',()=>{
  const fileOf=(r:InventoryRow)=>r.page>=10?1:0;const a=row('000001','A01','-3',1);const b=row('000001','A01','-4',10);
  const merged=mergeRows([a],[b],fileOf);
  assert.equal(merged.duplicates,0);assert.deepEqual(merged.rows,[a,b]);assert.deepEqual(merged.conflicts,[[b,a]]);
});
test('of two equal readings the clearer is kept, unless the kept one was already confirmed',()=>{
  const fileOf=(r:InventoryRow)=>r.page>=10?1:0;
  const poor=row('000001','A01','5',1,{issues:[POOR_NAME],attention:true,reviewed:false,name:'品頂'});const clean=row('000001','A01','5',10);
  assert.deepEqual(mergeRows([poor],[clean],fileOf).rows,[{...clean,sourceFiles:[0,1]}]);
  const confirmed={...poor,reviewed:true};assert.deepEqual(mergeRows([confirmed],[clean],fileOf).rows,[{...confirmed,sourceFiles:[0,1]}]);
  assert.deepEqual(mergeRows([clean],[poor],fileOf).rows,[{...clean,sourceFiles:[1,0]}]);
});
test('deduplication preserves per-file multiplicity across pages, order and PDF cloning',()=>{
  const fileOf=(r:InventoryRow)=>Math.floor(r.page/10);
  const a=[row('000001','A01','5',1),row('000001','A01','5',2)];
  const b=row('000001','A01','5',10);
  const c=[row('000001','A01','5',20),row('000001','A01','5',21),row('000001','A01','5',22)];
  for(const order of [[b,...a,...c],[...a,b,...c],[...c,b,...a]]){
    let rows:InventoryRow[]=[];let duplicates=0;
    for(const item of order){const merged=mergeRows(rows,[item],fileOf);rows=merged.rows;duplicates+=merged.duplicates;}
    assert.equal(rows.length,3);assert.equal(duplicates,3);
    const output=mergeRows([],structuredClone(rows),fileOf);
    assert.equal(output.rows.length,3,'PDF deduplication must preserve already matched occurrences');
    assert.equal(output.duplicates,0);
  }
  assert.equal(mergeRows([b],a,fileOf).rows.length,2,'one match cannot consume two lines from A');
  const poor={...b,issues:[POOR_NAME],reviewed:false,attention:true};
  let rows=mergeRows([poor],[a[0]],fileOf).rows;
  rows=mergeRows(rows,[row('000001','A01','5',11)],fileOf).rows;
  assert.equal(rows.length,2,'clearer replacement keeps the previous file provenance');
});
test('store titles: equal names continue, two different exact titles stop, anything unsure asks',()=>{
  assert.deepEqual(compareStores([{storeName:'26北-測試店',exact:true},{storeName:'26北-測試店 ',exact:false}]),{result:'same',name:'26北-測試店'});
  assert.equal(compareStores([{storeName:'26北-測試店 2026/10/01 09:12',exact:true},{storeName:'26北-測試店 115/10/05',exact:true}]).result,'same');
  assert.equal(compareStores([{storeName:'26北-測試店',exact:true},{storeName:'27北-其他店',exact:true}]).result,'different');
  assert.equal(compareStores([{storeName:'26北-測試店',exact:true},{storeName:'26北-測試后',exact:false}]).result,'unsure');
  assert.equal(compareStores([{storeName:'26北-測試店',exact:true},{storeName:'',exact:true}]).result,'unsure');
  assert.equal(storeKey('２６北 - 測試店'),'26北-測試店');
});
test('several files are numbered as one document',async()=>{
  const file=(name:string,pages:number)=>({file:{name},pages,render:async(p:number)=>`${name}:${p}`,textPage:async(p:number)=>`${name}:${p}`});
  const set=new SourceSet([file('a',2),file('b',1),file('c',3)] as any);
  assert.deepEqual(set.starts,[1,3,4]);assert.equal(set.pages,6);
  assert.deepEqual([1,2,3,4,5,6].map(p=>[set.fileIndex(p),set.localPage(p)]),[[0,1],[0,2],[1,1],[2,1],[2,2],[2,3]]);
  assert.equal(await set.render(5),'c:2');assert.equal(await set.textPage(3),'b:1');
});
const report=(n:number)=>({report:{page:n,width:1,height:1,rotation:0,deskew:0,status:'accepted' as const,reason:'',rowCount:0,skippedZero:0,storeName:''},rows:[]});
test('the first page of every file is read first, then the checkpoint, then the rest',async()=>{
  const calls:number[]=[];let checked=-1;
  const engine={layout:{},initialize:async()=>{},extract:async(_s:unknown,n:number)=>{calls.push(n);return report(n);},terminate:async()=>{}};
  const job=new InventoryJob(engine as any,{pages:7,starts:[1,4,6]} as any,{state:()=>{},page:()=>{},error:m=>assert.fail(m),checkpoint:async()=>{checked=calls.length;return undefined;}});
  await job.run();assert.deepEqual(calls,[1,4,6,2,3,5,7]);assert.equal(checked,3);assert.equal(job.state,'complete');assert.equal(job.completed,7);
  let errors:(string|undefined)[]=[];calls.length=0;
  const stopped=new InventoryJob(engine as any,{pages:7,starts:[1,4,6]} as any,{state:()=>{},page:()=>{},error:m=>errors.push(m),checkpoint:async()=>'不同門市'});
  await stopped.run();assert.deepEqual(calls,[1,4,6]);assert.equal(stopped.state,'error');assert.deepEqual(errors,['不同門市']);
  calls.length=0;let asked=false;
  const single=new InventoryJob(engine as any,{pages:3} as any,{state:()=>{},page:()=>{},error:m=>assert.fail(m),checkpoint:async()=>{asked=true;return 'x';}});
  await single.run();assert.deepEqual(calls,[1,2,3]);assert.equal(asked,false,'one file needs no store check');
});
// Synthetic system-printed report pages (upright, 1000 x 700), as in textlayer.test.ts.
const W=1000,H=700,size=10;const weight=(s:string)=>Array.from(s).reduce((n,c)=>n+(c.codePointAt(0)!>=0x2e80?2:1),0);
function textPage(store:string,items:[string,string,string,string][],header=true):TextPage{
  const cells:[string,number,number][]=[...(header?[[store,400,20],['庫存簡表',420,40],['商品代號',5,90],['名稱',95,90],['國際條碼',395,90],['簡稱',665,90],['儲位',745,90],['庫存量',825,90],['寄庫量',880,90],['庫別: 0026',5,115]] as [string,number,number][]:[]),
    ...items.flatMap(([sku,name,location,qty],i):[string,number,number][]=>{const y=140+i*40;return [[sku,5,y],['C-&10粒/盒'+name,95,y],['47100000000'+String(i).padStart(2,'0'),395,y],['A-測試',665,y],[location,745,y],[qty,840,y],['0',890,y]];}),
    ['報表編號: w_imlcl_1',5,680],['頁次 1 of 1',800,680]];
  return {viewport:[1,0,0,-1,0,H],width:W,height:H,hasImages:false,items:cells.map(([str,x,y])=>({str,width:weight(str)*size/2,transform:[size,0,0,size,x,H-y]}))};
}
const document=(name:string,pages:TextPage[])=>({file:{name},pages:pages.length,textPage:async(p:number)=>pages[p-1],render:async()=>{throw new Error('這一頁需要 OCR');}});
/** The browser flow without the DOM: queue order, store check, merge of each page. */
async function read(files:ReturnType<typeof document>[]){
  const set=new SourceSet(files as any);const pages:PageReport[]=[];let rows:InventoryRow[]=[];const errors:string[]=[];let conflicts=0;
  const engine=new OCREngine(()=>{});
  const job=new InventoryJob(engine,set,{state:()=>{},error:m=>errors.push(m),
    page:(report,pageRows)=>{const merged=mergeRows(rows,pageRows,r=>set.fileIndex(r.page));rows=merged.rows;report.duplicates=merged.duplicates;conflicts+=merged.conflicts.length;pages.push(report);},
    checkpoint:async()=>{const check=compareStores(set.starts.map(start=>{const page=pages.find(p=>p.page===start)!;return {storeName:page.storeName,exact:page.mode==='text'};}));return check.result==='same'?undefined:check.result;}});
  await job.run();return {job,engine,pages,rows,errors,conflicts};
}
test('two reports of one store: checked first, merged, duplicates removed, negatives first',async()=>{
  const a=document('a.pdf',[textPage('26北-測試店',[['000001','FIRST','A01','5'],['000002','SECOND','A02','-3']]),textPage('26北-測試店',[['000003','THIRD','A03','7']])]);
  const b=document('b.pdf',[textPage('26北-測試店',[['000003','THIRD','A03','7'],['000001','FIRST','A01','5'],['000004','FOURTH','A04','2'],['000002','SECOND','A02','-4']])]);
  const {job,engine,pages,rows,errors,conflicts}=await read([a,b]);
  assert.deepEqual(errors,[]);assert.equal(job.state,'complete');
  assert.deepEqual(pages.map(p=>[p.page,p.duplicates]),[[1,0],[3,1],[2,1]],'first pages of both files are read before page 2 of a.pdf');
  assert.deepEqual(rows.map(r=>[r.page,r.sku,r.bookQty]),[[1,'000001','5'],[1,'000002','-3'],[3,'000003','7'],[3,'000004','2'],[3,'000002','-4']]);
  assert.equal(conflicts,1,'000002 at A02 has -3 in a.pdf and -4 in b.pdf');
  assert.ok(engine.files.get(0)?.textLayout&&engine.files.get(1)?.textLayout,'each file learns its own columns');
  assert.deepEqual(sortRows(rows,'location').map(r=>r.sku),['000002','000002','000001','000003','000004']);
});
test('first-pages-first reading preserves repeated lines on a later page and in PDF output',async()=>{
  const a=document('a.pdf',[textPage('26北-測試店',[['000002','OTHER','A02','1']]),textPage('26北-測試店',[['000001','FIRST','A01','5'],['000001','FIRST','A01','5']])]);
  const b=document('b.pdf',[textPage('26北-測試店',[['000001','FIRST','A01','5']])]);
  for(const files of [[a,b],[b,a]]){
    const {job,rows,errors,pages}=await read(files);
    assert.equal(job.state,'complete');assert.deepEqual(errors,[]);
    assert.equal(rows.filter(r=>r.sku==='000001').length,2);
    assert.equal(pages.reduce((sum,p)=>sum+(p.duplicates??0),0),1);
    const set=new SourceSet(files as any);
    const output=mergeRows([],structuredClone(rows),r=>set.fileIndex(r.page));
    assert.equal(output.rows.filter(r=>r.sku==='000001').length,2);
  }
});
test('reports of different stores stop before the remaining pages are read',async()=>{
  const a=document('a.pdf',[textPage('26北-測試店',[['000001','FIRST','A01','5']]),textPage('26北-測試店',[['000003','THIRD','A03','7']])]);
  const b=document('b.pdf',[textPage('27北-其他店',[['000004','FOURTH','A04','2']])]);
  const {job,pages,errors}=await read([a,b]);
  assert.equal(job.state,'error');assert.deepEqual(errors,['different']);assert.deepEqual(pages.map(p=>p.page),[1,3]);
});
test('a file never reuses the columns learnt from another file',async()=>{
  // b.pdf has no header of its own: it may not borrow a.pdf's layout, so it falls back to OCR (none here) and the job stops.
  const a=document('a.pdf',[textPage('26北-測試店',[['000001','FIRST','A01','5']])]);
  const b=document('b.pdf',[textPage('',[['000004','FOURTH','A04','2']],false)]);
  const {job,rows,errors}=await read([a,b]);
  assert.equal(job.state,'error');assert.deepEqual(errors,['這一頁需要 OCR']);assert.deepEqual(rows.map(r=>r.sku),['000001']);
});
