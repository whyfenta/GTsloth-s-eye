import test from 'node:test';import assert from 'node:assert/strict';
import {parsePage,type ParsedPage} from '../src/management-parser';
import {derive,listRows,listSpec,NO_STOCK} from '../src/management-report';
import type {TextItem,TextPage} from '../src/textlayer';
import {readFileSync} from 'node:fs';
import {generateListPDF} from '../src/management-pdf';
import {pdfText} from './pdf-text';
const weight=(s:string)=>Array.from(s).reduce((n,c)=>n+(c.codePointAt(0)!>=0x2e80?2:1),0);
const W=1000,H=1400,size=10;
/** cells: [text, x, y], or [text, right edge, y, 'r'] for right-aligned numbers, in upright page pixels. */
type Cell=[string,number,number]|[string,number,number,'r'];
const page=(cells:Cell[],h=H):TextPage=>{
  const items=cells.map(([str,x,y,align])=>{const width=weight(str)*size/2;return {str,width,transform:[size,0,0,size,align==='r'?x-width:x,h-y]};});
  // The report stores text out of printed order (name, quantity, count, unit, code, price).
  return {viewport:[1,0,0,-1,0,h],width:W,height:h,hasImages:false,items:[...items].reverse()};
};
const usageHead=(n=1,total=2,payment='全部',store='營業點：0026 26測試店',period='統計期間：20260616 至 20261015'):Cell[]=>[
  ['醫品調劑數量統計表',420,20],[period,380,40],['列印時間：2026/10/16 下午 05:23:36',600,40],['給付方式：',10,60],[payment,70,60],[`頁次：${n}/${total}`,700,60],[store,10,80],
  ['醫品編號 醫品名稱',10,100],['單位',400,100],['次數',440,100],['數量',490,100],['健保價',540,100]];
const line=(y:number,code:string,name:string,unit:string,count:string,quantity:string,price='2'):Cell[]=>[[code,10,y],[name,80,y],...(unit?[[unit,400,y] as Cell]:[]),...(count?[[count,462,y,'r'] as Cell]:[]),...(quantity?[[quantity,512,y,'r'] as Cell]:[]),[price,572,y,'r']];
const usagePage=(n=1,total=2,extra:Cell[]=[])=>page([...usageHead(n,total),...line(120,'000206','C-30粒/盒EZETROL怡妥錠10MG','粒','67','1767','6.2'),...line(140,'000206','C-30粒/盒EZETROL怡妥錠10MG','粒','98','2520','6.7'),...line(160,'000009','C-FLIXOTIDE','瓶','2','2','472'),...extra]);

test('usage columns come from coordinates: count and quantity are not swapped, 健保價 is never read',()=>{
  const result=parsePage(usagePage(),'usage',0,1);assert.ok(result.ok,!result.ok?result.reason:'');
  const p=(result as {page:ParsedPage}).page;
  assert.deepEqual(p.usage.map(r=>[r.sku,r.rawName,r.unit,r.count,r.quantity]),[['000206','C-30粒/盒EZETROL怡妥錠10MG','粒','67','1767'],['000206','C-30粒/盒EZETROL怡妥錠10MG','粒','98','2520'],['000009','C-FLIXOTIDE','瓶','2','2']]);
  assert.deepEqual([p.reportPage,p.reportTotal,p.facts.payment,p.facts.store.number,p.facts.store.core],[1,2,'全部',26,'測試店']);
  assert.deepEqual(p.facts.period,{start:{y:2026,m:6,d:16},end:{y:2026,m:10,d:15}});
  assert.ok(p.usage.every(r=>r.reviewed&&!r.notes.length));
});
test('a long count or quantity still lands in its own column; R001 without unit is an excluded record',()=>{
  const p=(parsePage(usagePage(1,2,[...line(180,'000010','C-長數字','粒','12345','1234567','1'),...line(200,'R001','因處方簽遺失或損毀，提前回診之領藥','','1','1','0')]),'usage',0,1) as {page:ParsedPage}).page;
  const long=p.usage.find(r=>r.sku==='000010')!;assert.deepEqual([long.count,long.quantity],['12345','1234567']);
  const r001=p.usage.find(r=>r.sku==='R001')!;assert.equal(r001.unit,'');assert.match(r001.excluded!,/R001/);
});
test('a line with numbers but no code stays as a review row instead of disappearing',()=>{
  const p=(parsePage(usagePage(1,2,[['C-無代號',80,180],['粒',400,180],['5',462,180,'r'],['50',512,180,'r']]),'usage',0,1) as {page:ParsedPage}).page;
  const row=p.usage.find(r=>!r.sku)!;assert.deepEqual([row.count,row.quantity,row.excluded],['5','50',undefined]);
});
test('usage pages without period, payment, store or page number are refused; scans and the other report too',()=>{
  const strip=(word:string)=>page(usageHead().filter(c=>!c[0].startsWith(word)).concat(line(120,'000001','C-A','粒','1','1')));
  for(const word of ['統計期間','頁次','營業點']){const r=parsePage(strip(word),'usage',0,1);assert.equal(r.ok,false,word);}
  assert.match((parsePage({...usagePage(),hasImages:true},'usage',0,1) as {reason:string}).reason,/圖片/);
  assert.match((parsePage(usagePage(),'inventory',0,1) as {reason:string}).reason,/請放到「醫品調劑數量統計表」區/);
  assert.match((parsePage(undefined,'usage',0,1) as {reason:string}).reason,/不接受圖片檔/);
  const swapped=page([...usageHead().filter(c=>c[0]!=='次數'&&c[0]!=='數量'),['數量',440,100],['次數',490,100]]);
  assert.match((parsePage(swapped,'usage',0,1) as {reason:string}).reason,/順序/);
});
// The inventory sheet as in the inventory tool's own text-layer test, with a page number.
const stockCells=(n=1,total=1,title='26北-測試店',rows:Cell[]=[]):Cell[]=>[[title,400,20],['庫 存 簡 表',420,40],
  ['商品代號',5,90],['名稱',95,90],['國際條碼',395,90],['簡稱',665,90],['儲位',745,90],['庫存量',825,90],['寄庫量',880,90],['庫別: 0026',5,115],
  ['000206',5,140],['C-30粒/盒EZETROL怡妥錠10MG',95,140],['0840164529432',395,140],['A-裕利',665,140],['5脂41@',745,140],['1,990',830,140],['0',890,140],
  ['000083',5,160],['缺貨C-1000粒/盒(10粒/排)PENTOP循妥斯持續性錠400MG',95,160],['4713801198482',395,160],['A-優生',665,160],['3心16',745,160],['368',840,160],['0',890,160],
  ['000500',5,180],['C-未使用藥',95,180],['4710000000500',395,180],['A-測試',665,180],['',745,180],['-2',840,180],['0',890,180],
  ...rows,['0026庫別小計:',600,230],['報表編號: w_im1c1_1 列印時間：2026/10/11 09:02:13',5,680],[`頁次 ${n} of ${total}`,800,680]];
const stockPage=(n=1,total=1,title='26北-測試店',rows:Cell[]=[])=>page(stockCells(n,total,title,rows),700);
const fix=(p:TextPage)=>p;
test('the inventory sheet keeps 缺貨, reads stock not consigned stock, and needs its page number',()=>{
  const result=parsePage(fix(stockPage()),'inventory',1,1);assert.ok(result.ok,!result.ok?result.reason:'');
  const p=(result as {page:ParsedPage}).page;
  assert.deepEqual(p.stock.map(r=>[r.sku,r.name,r.location,r.qty]),[['000206','EZETROL怡妥錠10MG','5脂41@','1990'],['000083','缺貨 PENTOP循妥斯持續性錠400MG','3心16','368'],['000500','未使用藥','','-2']]);
  assert.deepEqual([p.facts.store.number,p.facts.warehouse,p.facts.printed],[26,'0026',{y:2026,m:10,d:11}]);
  const noPage=page(stockCells().filter(c=>!c[0].startsWith('頁次')),700);
  assert.match((parsePage(noPage,'inventory',1,1) as {reason:string}).reason,/頁次/);
});
const parsed=(text:TextPage,kind:'usage'|'inventory',file:number,filePage:number)=>{const r=parsePage(text,kind,file,filePage);assert.ok(r.ok,!r.ok?r.reason:'');return (r as {page:ParsedPage}).page;};
const decisions={storeConfirmed:false,scopeConfirmed:true,zeroConfirmed:false,missingAcknowledged:''};
test('strategy selection reaches derived rows and the printed PDF, while list membership and slot lists stay stable',async()=>{
  const usage=parsed(page([...usageHead(1,1),...line(120,'000206','C-EZETROL怡妥錠10MG','粒','165','4287'),
    ...line(140,'000083','C-B','粒','120','1200'),...line(160,'000009','C-C','粒','80','800'),...line(180,'000010','C-D','粒','40','400'),
    ...Array.from({length:36},(_,i)=>line(200+i*20,String(400000+i),'C-低頻','粒','1','1')).flat()]),'usage',0,1);
  const stock=parsed(stockPage(),'inventory',1,1);const pages=[usage,stock];
  const baseline=derive(pages,[],{...decisions,zeroConfirmed:true,missingAcknowledged:'000009,000010'});
  assert.equal(baseline.safety!.strategy,'hamster');
  const font=new Uint8Array(readFileSync('public/assets/fonts/NotoSansTC-PDF.ttf'));
  // 000083 keeps 缺貨 on the stock sheet: one more month of use (300) on every strategy's coefficient.
  for(const [strategy,name,range,values,toOrder] of [
    ['hamster','倉鼠派','3.5～1.2',['3,754','1,350','470','120'],['1,764','982','—','—']],
    ['balanced','平衡派','2.5～0.8',['2,682','1,050','330','80'],['692','682','—','—']],
    ['antelope','羚羊派','1.2～0.6',['1,287','660','180','60'],['0','292','—','—']],
  ] as const){
    const result=derive(pages,[],{...decisions,zeroConfirmed:true,missingAcknowledged:'000009,000010',safetyStrategy:strategy});
    assert.equal(result.available.safety,true);assert.equal(result.safety!.strategy,strategy);
    assert.deepEqual(result.safety!.rows.map(r=>r.shortage),[false,true,false,false]);
    assert.deepEqual(listRows('safety',result).map(row=>row.slice(0,5)),listRows('safety',baseline).map(row=>row.slice(0,5)));
    assert.deepEqual(listRows('safety',result).map(row=>row[5]),values,'建議安全量');
    assert.deepEqual(listRows('safety',result).map(row=>row[6]),toOrder,'待採量 = 建議安全量 − 現有庫存量, 0 at least, — without a stock line');
    for(const kind of ['dead','empty'] as const)assert.deepEqual(listRows(kind,result),listRows(kind,baseline));
    const spec=listSpec('safety',result,{files:{usage:['u.pdf'],inventory:['s.pdf']},version:2,appVersion:'test',time:'now'});
    assert.match(spec.title,new RegExp(`^安全量調整及採購建議清單 · ${name}$`));assert.ok(spec.note.includes(`係數 ${range}`));
    assert.deepEqual(spec.columns.map(c=>c.label),['六編碼','品名','現有庫存量','調劑頻率(/月)','均月銷','建議安全量','待採量']);
    const pdf=await generateListPDF(spec,font);const printed=(await pdfText(pdf.bytes))[0].text;
    for(const text of [name,range,'待採量',...values,...toOrder.filter(v=>v!=='—')])assert.ok(printed.includes(text),`printed ${strategy}: ${text}`);
  }
});
test('a missing page blocks every list; adding it from a second file (from page 2) completes the report',()=>{
  const first=parsed(usagePage(1,2),'usage',0,1);const stock=parsed(fix(stockPage()),'inventory',1,1);
  const partial=derive([first,stock],[],decisions);assert.equal(partial.ready,false);assert.ok(partial.blockers.some(b=>/缺少第 2 頁/.test(b)));
  const second=parsed(page([...usageHead(2,2),...line(120,'000300','C-第二頁','粒','1','1')]),'usage',2,1);
  const again=parsed(usagePage(1,2),'usage',3,1);
  const full=derive([first,stock,second,again],[],decisions);assert.deepEqual(full.blockers,[]);assert.equal(full.usage.duplicates.length,1,'the same page imported twice counts once');
  assert.equal(full.summary.items.length,3);assert.equal(full.ready,true);
  assert.deepEqual(full.dead.map(r=>[r.sku,r.negative]),[['000083',false],['000500',true]],'not used: 000083 and the negative 000500 (marked, blank location last); 000206 is used');
});
test('different periods, payment scopes or stores are never mixed',()=>{
  const stock=parsed(fix(stockPage()),'inventory',1,1);const one=parsed(page([...usageHead(1,1),...line(120,'000206','C-A','粒','1','1')]),'usage',0,1);
  const otherPeriod=parsed(page([...usageHead(1,1,'全部','營業點：0026 26測試店','統計期間：20260601 至 20261015'),...line(120,'000206','C-A','粒','1','1')]),'usage',2,1);
  assert.ok(derive([one,otherPeriod,stock],[],decisions).blockers.some(b=>/不能混算/.test(b)));
  const otherStore=parsed(fix(stockPage(1,1,'27北-測試店')),'inventory',1,1);
  const result=derive([one,otherStore],[],{...decisions,storeConfirmed:true});assert.ok(result.blockers.some(b=>/不是同一門市/.test(b)),'a confirmation cannot override different store numbers');
  const partial=parsed(page([...usageHead(1,1,'健保'),...line(120,'000206','C-A','粒','1','1')]),'usage',0,1);
  const scoped=derive([partial,stock],[],decisions);assert.equal(scoped.available.safety,true);assert.equal(scoped.available.dead,false);assert.match(scoped.reasons.dead,/給付方式/);
});
test('stock printed before the period end is a note, not a refusal; usage codes missing from stock are listed, not zeroed',()=>{
  const stock=parsed(fix(stockPage()),'inventory',1,1);const usage=parsed(usagePage(1,1),'usage',0,1);
  const result=derive([usage,stock],[],decisions);
  assert.deepEqual(result.blockers,[]);assert.ok(result.warnings.some(w=>/2026\/10\/11.*2026\/10\/15/.test(w)));
  assert.deepEqual(result.missing.map(m=>m.sku),['000009']);assert.equal(result.summary.items.length,2,'N keeps the unmatched code');
  assert.match(result.reasons.empty,/零庫存/,'a sheet without zero rows cannot prove empty slots');
  assert.equal(derive([usage,stock],[],{...decisions,zeroConfirmed:true}).available.empty,true);
  assert.equal(derive([usage,stock],[],{...decisions,scopeConfirmed:false}).available.dead,false);
});
test('a store with a partner clinic: more than 10 codes of the safety list without stock (no line or 0) are skipped and backfilled',()=>{
  const stock=parsed(fix(stockPage()),'inventory',1,1); // 000206, 000083, 000500
  // N = 120, 10% = 12. 000206 A = 50; `missing` codes without a stock line A = 25; 000083 A = 10; the rest A = 0.25.
  const usage=(missing:number)=>{const lines=[line(120,'000206','C-A','粒','200','200'),...Array.from({length:missing},(_,i)=>line(140+i*20,String(300000+i),`C-合作${i}`,'粒','100','100')),line(140+missing*20,'000083','C-B','粒','40','40'),
    ...Array.from({length:118-missing},(_,i)=>line(160+(missing+i)*20,String(400000+i),`C-品項${i}`,'粒','1','1'))];return parsed(page([...usageHead(1,1),...lines.flat()],2700),'usage',0,1);};
  const own=derive([usage(10),stock],[],decisions); // exactly 10 on the list: still our own stock, each needs an acknowledgement
  assert.equal(own.partner,undefined);assert.equal(own.safety!.k,12);assert.equal(own.missingKey.split(',').length,10);assert.match(own.reasons.safety,/10 個六碼/);
  assert.equal(listRows('safety',own).filter(r=>r[2]===NO_STOCK).length,10);
  const partner=derive([usage(11),stock],[],decisions);
  for(const safetyStrategy of ['hamster','balanced','antelope'] as const){
    const alternative=derive([usage(11),stock],[],{...decisions,safetyStrategy});
    assert.equal(alternative.safety!.strategy,safetyStrategy);
    assert.deepEqual(alternative.partner,partner.partner);
    assert.deepEqual(alternative.safety!.rows.map(r=>r.sku),partner.safety!.rows.map(r=>r.sku));
    assert.deepEqual(alternative.safety!.outside,partner.safety!.outside);
  }
  assert.deepEqual(partner.partner,{missing:11});assert.equal(partner.safety!.n,120,'N keeps the partner codes');
  assert.deepEqual(partner.safety!.rows.map(r=>r.sku),['000206','000083'],'000083 moves up; K stays within the stock-sheet codes with A > 8');
  assert.deepEqual(partner.safety!.outside,{none:11,low:0,filled:1});
  assert.ok(partner.missing.every(m=>!m.onList));assert.equal(partner.missingKey,'');assert.equal(partner.available.safety,true,'no acknowledgement needed');
  assert.ok(listRows('safety',partner).every(r=>r[2]!==NO_STOCK));
  const spec=listSpec('safety',partner,{files:{usage:['u.pdf'],inventory:['s.pdf']},version:1,appVersion:'test',time:'now'});
  assert.equal(spec.meta.length,3);assert.match(spec.meta[2],/合作診所供貨，略過無庫存 11、不足 0.1 月 0 筆，遞補 1 筆；取 K = 2 筆/);assert.match(spec.note,/有 11 個六碼簡表無紀錄或庫存合計為 0（> 10）/);
  assert.equal(derive([usage(11)],[],decisions).partner,undefined,'no verdict before the stock sheet is read');
  // A line printed with 0 stock means the same as no line: 10 missing + 1 at zero is 11.
  const zeroStock=parsed(fix(stockPage(1,1,'26北-測試店',[['300000',5,200],['C-合作0',95,200],['4710000300000',395,200],['A-測試',665,200],['冰-合作診所',745,200],['0',840,200],['0',890,200]])),'inventory',1,1);
  const zero=derive([usage(11),zeroStock],[],decisions);
  assert.equal(zero.missing.length,10+107,'300000 has a line, so it is not a missing code');assert.deepEqual(zero.partner,{missing:11});
  assert.ok(!zero.safety!.rows.some(r=>r.sku==='300000'),'skipped like a code without a line');
  const tenWithZero=derive([usage(10),zeroStock],[],decisions);
  assert.equal(tenWithZero.partner,undefined);assert.deepEqual(listRows('safety',tenWithZero).find(r=>r[0]==='300000')?.[2],'0','not a partner store: the zero line stays listed with its 0');
});
const sideways=(p:TextPage):TextPage=>({...p,width:p.height,height:p.width,viewport:[1,0,0,-1,0,p.width],items:p.items.map((item):TextItem=>{const x=item.transform[4],y=p.height-item.transform[5];return {...item,transform:[0,size,-size,0,y,x]};})});
test('a sideways-printed page is read in its text direction',()=>{
  const upright=fix(stockPage());const turned=sideways(upright);
  assert.deepEqual(parsed(turned,'inventory',1,1).stock.map(r=>[r.sku,r.qty]),parsed(upright,'inventory',1,1).stock.map(r=>[r.sku,r.qty]));
});
