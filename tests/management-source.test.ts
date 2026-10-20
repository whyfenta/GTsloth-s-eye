import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {parsePage,type ParsedPage} from '../src/management-parser';
import {derive,listRows,listSpec,NO_STOCK,SELF_PAY_HEADING,selfPayRows,type Decisions} from '../src/management-report';
import {formatFrac} from '../src/management-model';
import {generateListPDF} from '../src/management-pdf';
import type {TextPage} from '../src/textlayer';
import {pdfText} from './pdf-text';
// The attached templates stay private: set MANAGEMENT_USAGE_PDF and MANAGEMENT_INVENTORY_PDF to run this file.
const usageFile=process.env.MANAGEMENT_USAGE_PDF;const stockFile=process.env.MANAGEMENT_INVENTORY_PDF;
const HASH={usage:'5fcf152365bb160fab59c048bf749deee0c4b45bec275e2db107badd58c07cb1',inventory:'5cbc643b3069aa1e9dc55c75a0ab7787fb74b129fafb00de7ba40353b5297e05'};
async function readPages(file:string){
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const images=new Set([pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject,pdfjs.OPS.paintImageMaskXObject,pdfjs.OPS.paintImageXObjectRepeat,pdfjs.OPS.paintInlineImageXObjectGroup,pdfjs.OPS.paintImageMaskXObjectGroup,pdfjs.OPS.paintImageMaskXObjectRepeat]);
  const doc=await pdfjs.getDocument({data:new Uint8Array(fs.readFileSync(file)),isEvalSupported:false,verbosity:0}).promise;const pages:TextPage[]=[];
  for(let n=1;n<=doc.numPages;n++){const page=await doc.getPage(n);const vp=page.getViewport({scale:300/72});const ops=await page.getOperatorList();const content=await page.getTextContent();
    pages.push({viewport:vp.transform,width:Math.ceil(vp.width),height:Math.ceil(vp.height),hasImages:ops.fnArray.some(f=>images.has(f)),items:content.items.flatMap((i:any)=>'str' in i?[{str:i.str,transform:i.transform,width:i.width}]:[])});}
  return pages;
}
const parseAll=(pages:TextPage[],kind:'usage'|'inventory',file:number)=>pages.map((page,i)=>{const r=parsePage(page,kind,file,i+1);assert.ok(r.ok,`${kind} page ${i+1}: ${!r.ok&&r.reason}`);return (r as {page:ParsedPage}).page;});
const none:Decisions={storeConfirmed:false,scopeConfirmed:false,zeroConfirmed:false,missingAcknowledged:'',safetyStrategy:'hamster'};
test('attached templates: every page parses and the documented baseline is reproduced',async t=>{
  if(!usageFile||!stockFile||!fs.existsSync(usageFile)||!fs.existsSync(stockFile))return t.skip('Set MANAGEMENT_USAGE_PDF and MANAGEMENT_INVENTORY_PDF to the private templates.');
  assert.equal(createHash('sha256').update(fs.readFileSync(usageFile)).digest('hex'),HASH.usage);
  assert.equal(createHash('sha256').update(fs.readFileSync(stockFile)).digest('hex'),HASH.inventory);
  const usage=parseAll(await readPages(usageFile),'usage',0);const stock=parseAll(await readPages(stockFile),'inventory',1);
  assert.equal(usage.length,28);assert.equal(stock.length,29);assert.ok(stock.every(p=>p.facts.reportTotal===29));
  const data=derive([...usage,...stock],[],none,{y:2026,m:10,d:16});
  assert.deepEqual(data.blockers,[]);assert.equal(data.storeMatch,'same');assert.equal(data.ready,true,'text PDFs need no row review');
  assert.deepEqual(data.warnings.length,1,'stock printed 2026/10/11, before the 2026/10/15 period end');
  assert.equal(data.period,'2026/06/16～2026/10/15');assert.equal(formatFrac(data.months!),'4');assert.equal(data.payment,'全部');
  const valid=data.usageRows.filter(r=>!r.excluded);const excluded=data.usageRows.filter(r=>r.excluded);
  assert.equal(valid.length,1108);assert.deepEqual(excluded.map(r=>r.sku),['R001']);
  const s=data.safety!;assert.deepEqual([s.n,s.limit,s.eligible,s.k],[1069,106,175,106]);
  const row=s.rows.find(r=>r.sku==='000206')!;
  assert.deepEqual([formatFrac(row.count),formatFrac(row.quantity),formatFrac(row.a),row.b,formatFrac(row.ab),formatFrac(row.coefficient),row.safety,formatFrac(row.stock!)],['165','4,287','41.25',26n,'1,072.5','3.5',3754n,'1,990']);
  assert.equal(data.stockRows.length,1002);assert.equal(data.stockRows.find(r=>r.sku==='000206')!.location,'5脂41@');
  assert.equal(data.stockRows.find(r=>r.sku==='000083')!.name,'缺貨 PENTOP循妥斯持續性錠400MG');
  assert.equal(data.zeroRows,0,'this sheet was printed without zero stock');
  // 197 used codes have no stock line; they are listed, never zeroed, and N keeps them.
  assert.equal(data.missing.length,197);assert.deepEqual(data.missing.filter(m=>m.onList).map(m=>m.sku),['123863','159262']);
  assert.equal(data.partner,undefined,'only 2 of them, not more than 10: no partner clinic, so they stay on the list');
  assert.match(data.reasons.safety,/2 個六碼/);assert.equal(data.available.dead,false,'scope not yet confirmed');assert.equal(data.available.empty,false);
});
test('attached templates: the three lists after the reviewer\'s decisions, printed as A4 PDFs',async t=>{
  if(!usageFile||!stockFile||!fs.existsSync(usageFile)||!fs.existsSync(stockFile))return t.skip('Set MANAGEMENT_USAGE_PDF and MANAGEMENT_INVENTORY_PDF to the private templates.');
  const pages=[...parseAll(await readPages(usageFile),'usage',0),...parseAll(await readPages(stockFile),'inventory',1)];
  const data=derive(pages,[],{...none,scopeConfirmed:true,missingAcknowledged:'123863,159262'});
  assert.deepEqual(data.available,{safety:true,dead:true,empty:false});assert.match(data.reasons.empty,/零庫存/);
  const safety=listRows('safety',data);assert.equal(safety.length,106);
  assert.deepEqual(safety.find(r=>r[0]==='000206'),['000206','EZETROL怡妥錠10MG','1,990','41.25','1,072.5','3,754','1,764']);
  assert.deepEqual(safety.filter(r=>r[2]===NO_STOCK).map(r=>r[0]),['123863','159262']);
  const dead=listRows('dead',data);assert.equal(dead.length,data.dead.length);assert.ok(dead.length>0);
  // Self-pay products are never NHI dispensing: 自費 lines outside the usage report follow the dead stock in grey, not in it.
  const own=selfPayRows(data).map(r=>r[0]);assert.ok(data.selfPay.every(r=>r.qty!=='0'));
  for(const sku of ['005157','099972','106508','122504','126313','165341','165342','175305'])assert.ok(own.includes(sku),sku);
  assert.ok(!own.includes('000289')&&!own.includes('178361'),'self-pay codes in the usage report are used');
  assert.ok(!dead.some(r=>own.includes(r[0])));
  const empty=derive(pages,[],{...none,scopeConfirmed:true,zeroConfirmed:true,missingAcknowledged:'123863,159262'});assert.equal(empty.available.empty,true);assert.equal(empty.empty.length,0);
  const font=new Uint8Array(fs.readFileSync('public/assets/fonts/NotoSansTC-PDF.ttf'));
  const context={files:{usage:['usage.pdf'],inventory:['261011_09p.pdf']},version:7,appVersion:'test',time:'2026/10/17 10:00'};
  const out=process.env.MANAGEMENT_OUTPUT_DIR;
  for(const [kind,source] of [['safety',data],['dead',data],['empty',empty]] as const){
    const result=await generateListPDF(listSpec(kind,source,context),font);const text=await pdfText(result.bytes);
    if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(`${out}/${kind}.pdf`,result.bytes);}
    assert.equal(result.pageCount,text.length);
    for(const [i,page] of text.entries())for(const word of ['26永和福和店','2026/06/16～2026/10/15',kind==='safety'?'品名':'清理後名稱','校對版本 7',`${i+1} / ${text.length}`])assert.ok(page.text.includes(word),`${kind} page ${i+1}: ${word}`);
    const codes=text.flatMap(page=>page.text.match(/^\d{6}$/gm)??[]);
    const tail=kind==='dead'?selfPayRows(source).map(r=>r[0]):[];
    assert.deepEqual(codes,[...listRows(kind,source).map(r=>r[0]),...tail],`${kind}: every code once, in list order, self-pay last`);
    assert.equal(text.some(page=>page.text.includes(SELF_PAY_HEADING)),tail.length>0);
  }
});
