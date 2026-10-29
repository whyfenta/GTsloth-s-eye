import test from 'node:test';import assert from 'node:assert/strict';
import {parsePage,type ParsedPage} from '../src/management-parser';
import {derive,listAlerts,listRows,listSpec,NO_STOCK,SAFETY_ALERT_NOTE} from '../src/management-report';
import {formatFrac} from '../src/management-model';
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

test('usage columns come from coordinates: count and quantity are not swapped, 健保價 is kept per line',()=>{
  const result=parsePage(usagePage(),'usage',0,1);assert.ok(result.ok,!result.ok?result.reason:'');
  const p=(result as {page:ParsedPage}).page;
  assert.deepEqual(p.usage.map(r=>[r.sku,r.rawName,r.unit,r.count,r.quantity,r.price]),[['000206','C-30粒/盒EZETROL怡妥錠10MG','粒','67','1767','6.2'],['000206','C-30粒/盒EZETROL怡妥錠10MG','粒','98','2520','6.7'],['000009','C-FLIXOTIDE','瓶','2','2','472']]);
  assert.deepEqual([p.reportPage,p.reportTotal,p.facts.payment,p.facts.store.number,p.facts.store.core],[1,2,'全部',26,'測試店']);
  assert.deepEqual(p.facts.period,{start:{y:2026,m:6,d:16},end:{y:2026,m:10,d:15}});
  assert.ok(p.usage.every(r=>r.reviewed&&!r.notes.length));
});
test('a long count or quantity still lands in its own column; R001 without unit is an excluded record',()=>{
  const p=(parsePage(usagePage(1,2,[...line(180,'000010','C-長數字','粒','12345','1234567','1'),...line(200,'R001','因處方簽遺失或損毀，提前回診之領藥','','1','1','0')]),'usage',0,1) as {page:ParsedPage}).page;
  const long=p.usage.find(r=>r.sku==='000010')!;assert.deepEqual([long.count,long.quantity],['12345','1234567']);
  const r001=p.usage.find(r=>r.sku==='R001')!;assert.equal(r001.unit,'');assert.match(r001.excluded!,/R001/);
});
test('a line without 健保價, or with two, is noted for review; a blank price is no error',()=>{
  const p=(parsePage(usagePage(1,2,[['000011',10,180],['C-無價',80,180],['粒',400,180],['5',462,180,'r'],['50',512,180,'r'],...line(200,'000012','C-兩價','粒','1','1','3'),['4',592,200,'r']]),'usage',0,1) as {page:ParsedPage}).page;
  const none=p.usage.find(r=>r.sku==='000011')!;assert.deepEqual([none.price,none.reviewed,none.notes],['',false,['缺少健保價，待採金額無法估算，請核對原圖']]);
  const two=p.usage.find(r=>r.sku==='000012')!;assert.equal(two.reviewed,false);assert.match(two.notes.join(),/健保價欄有多個值（3、4）/);
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
const decisions={storeConfirmed:false};
test('strategy selection reaches derived rows and the printed PDF, while list membership and slot lists stay stable',async()=>{
  const usage=parsed(page([...usageHead(1,1),...line(120,'000206','C-EZETROL怡妥錠10MG','粒','165','4287'),
    ...line(140,'000083','C-B','粒','120','1200','1.2'),...line(160,'000009','C-C','粒','80','800'),...line(180,'000010','C-D','粒','40','400'),
    ...Array.from({length:36},(_,i)=>line(200+i*20,String(400000+i),'C-低頻','粒','1','1')).flat()]),'usage',0,1);
  const stock=parsed(stockPage(),'inventory',1,1);const pages=[usage,stock];
  const printDay={y:2026,m:10,d:16};
  const baseline=derive(pages,[],decisions,printDay);
  assert.equal(baseline.safety!.strategy,'balanced','平衡派 is the default');
  assert.equal(baseline.missing.filter(m=>m.onList).length,2);
  assert.equal(baseline.available.safety,true,'missing stock-sheet codes never require acknowledgement');
  const font=new Uint8Array(readFileSync('public/assets/fonts/NotoSansTC-PDF.ttf'));
  // 000083 keeps 缺貨 on the stock sheet: one more month of use (300) on every strategy's coefficient.
  // 待採量 × 健保價 (000206 at 2, 000083 at 1.2): 3,528 and 1,178.4 / 1,384 and 818.4 / 0 and 350.4; red above 1,000.
  for(const [strategy,name,range,values,toOrder,large] of [
    ['hamster','倉鼠派','3.5～1.2',['3,754','1,350','470','120'],['1,764','982','—','—'],[true,true,false,false]],
    ['balanced','平衡派','2.5～0.8',['2,682','1,050','330','80'],['692','682','—','—'],[true,false,false,false]],
    ['antelope','羚羊派','1.2～0.6',['1,287','660','180','60'],['0','292','—','—'],[false,false,false,false]],
  ] as const){
    const result=derive(pages,[],{...decisions,safetyStrategy:strategy},printDay);
    assert.equal(result.available.safety,true);assert.equal(result.safety!.strategy,strategy);
    assert.deepEqual(result.safety!.rows.map(r=>r.shortage),[false,true,false,false]);
    assert.deepEqual(listRows('safety',result).map(row=>row.slice(0,5)),listRows('safety',baseline).map(row=>row.slice(0,5)));
    assert.deepEqual(listRows('safety',result).map(row=>row[5]),values,'建議安全量');
    // 000206: 1,990 > 4 × 1,072.5 is false; 000083: 368 ≤ 4 × 300; 000009/000010 have no stock line.
    assert.deepEqual(listAlerts('safety',result).map(row=>row[2]),[false,false,false,false]);
    assert.deepEqual(listAlerts('safety',result).map(row=>row[6]),large,'待採量 is red when worth more than 1,000 at 健保價');
    assert.deepEqual(listAlerts('safety',result).map(row=>row[1]),[false,true,false,false],'the name of a 缺貨 code is red');
    assert.deepEqual(listAlerts('safety',result).map(row=>row.filter(Boolean).length),large.map((v,i)=>Number(v)+Number(i===1)),'no other cell is marked');
    assert.deepEqual(listRows('safety',result).map(row=>row[6]),toOrder,'待採量 = 建議安全量 − 現有庫存量, 0 at least, — without a stock line');
    for(const kind of ['dead','empty'] as const)assert.deepEqual(listRows(kind,result),listRows(kind,baseline));
    const spec=listSpec('safety',result,{files:{usage:['u.pdf'],inventory:['s.pdf']},version:2,appVersion:'test',time:'now'});
    assert.equal(spec.title,`安全量調整及採購建議清單 · ${name}（係數 ${range}）`);
    assert.equal(spec.note,SAFETY_ALERT_NOTE,'the footer repeats no formula');
    assert.equal(SAFETY_ALERT_NOTE,'紅色：品名保有「缺貨」前綴（供應商缺貨）；紅色粗體：現有庫存量 > 4 倍均月銷，醫院換藥致用量銳減時易逾期耗損；待採量 × 健保價 > 1,000 元，優先採購可更快達免運門檻（(管3)(管4)管制藥只能申請，不標示）。');
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
  const scoped=derive([partial,stock],[],decisions);assert.equal(scoped.available.safety,true);assert.equal(scoped.available.dead,true,'payment coverage does not gate dead stock');
});
test('stock printed before the period end is a note, not a refusal; usage codes missing from stock are listed, not zeroed',()=>{
  const stock=parsed(fix(stockPage()),'inventory',1,1);const usage=parsed(usagePage(1,1),'usage',0,1);
  const result=derive([usage,stock],[],decisions);
  assert.deepEqual(result.blockers,[]);assert.ok(result.warnings.some(w=>/2026\/10\/11.*2026\/10\/15/.test(w)));
  assert.deepEqual(result.missing.map(m=>m.sku),['000009']);assert.equal(result.summary.items.length,2,'N keeps the unmatched code');
  assert.match(result.reasons.empty,/庫存為 0/,'without unused zero-stock rows the empty-slot list is unavailable');
  assert.equal(result.available.empty,false);
  assert.equal(result.available.dead,true,'no manual scope acknowledgement is needed');
});
test('dead stock and empty slots require more than 2.5 months; empty slots also require unused zero-stock rows',()=>{
  const stock=parsed(stockPage(),'inventory',1,1);
  stock.stock.find(r=>r.sku==='000083')!.qty='0';
  const usage=(end:string)=>parsed(page([...usageHead(1,1,'健保','營業點：0026 26測試店',`統計期間：20260401 至 ${end}`),...line(120,'000206','C-A','粒','1','1')]),'usage',0,1);
  const boundary=derive([usage('20260615'),stock],[],decisions);
  assert.equal(formatFrac(boundary.months!),'2.5');assert.equal(boundary.available.dead,false);assert.match(boundary.reasons.dead,/大於 2.5/);
  assert.equal(boundary.available.empty,false);assert.equal(boundary.reasons.empty,boundary.reasons.dead);assert.equal(boundary.available.safety,true);assert.deepEqual(listRows('empty',boundary).map(r=>r[0]),['000083']);
  const longer=derive([usage('20260616'),stock],[],decisions);
  assert.equal(longer.available.dead,true);assert.equal(longer.available.empty,true);
  const short=derive([usage('20260430'),stock],[],decisions);
  assert.equal(short.available.dead,false);assert.equal(short.available.empty,false,'one month is too short even when an unused zero-stock row exists');assert.match(short.reasons.empty,/大於 2.5/);
  const twoMonths=derive([usage('20260531'),stock],[],decisions);
  assert.equal(formatFrac(twoMonths.months!),'2');assert.equal(twoMonths.available.empty,false);assert.equal(twoMonths.available.dead,false);assert.equal(twoMonths.available.safety,true);
  assert.match(twoMonths.reasons.empty,/統計期間 2 個月，須大於 2.5/);
  const usedOnly=structuredClone(stock);usedOnly.stock.find(r=>r.sku==='000083')!.qty='368';usedOnly.stock.find(r=>r.sku==='000206')!.qty='0';
  const noSlots=derive([usage('20260616'),usedOnly],[],decisions);
  assert.equal(noSlots.zeroRows,1);assert.equal(noSlots.available.dead,true);assert.equal(noSlots.available.empty,false,'zero stock already present in usage is not an empty slot');
  const excluded=structuredClone(stock);excluded.stock.find(r=>r.sku==='000083')!.excluded='使用者排除：來源不適用';
  assert.equal(derive([usage('20260616'),excluded],[],decisions).available.empty,false,'excluded zero-stock rows are not candidates');
  const pending=structuredClone(stock);pending.stock[0].reviewed=false;
  const unfinished=derive([usage('20260616'),pending],[],decisions);
  assert.equal(unfinished.available.dead,false);assert.equal(unfinished.available.empty,false,'review must still be complete');
});
test('a report printed a week or more before today carries a warning on the page and on every printed list',()=>{
  const stock=parsed(fix(stockPage()),'inventory',1,1);const usage=parsed(usagePage(1,1),'usage',0,1);
  const ctx={files:{usage:['u.pdf'],inventory:['s.pdf']},version:1,appVersion:'test',time:'now'};
  const fresh=derive([usage,stock],[],decisions,{y:2026,m:10,d:17}); // stock printed 10/11: 6 days, usage 10/16: 1 day
  assert.deepEqual(fresh.stale,[]);assert.ok(!fresh.warnings.some(w=>/失真/.test(w)));assert.ok(!listSpec('dead',fresh,ctx).warning);
  const old=derive([usage,stock],[],decisions,{y:2026,m:10,d:18}); // stock 7 days: warned; usage 2 days: not
  assert.ok(old.warnings.every(w=>!w.includes('一週以上')&&!w.includes('門市現況可能已改變')));
  assert.deepEqual(old.stale.map(s=>[s.kind,s.days]),[['inventory',7]]);
  assert.ok(old.warnings.some(w=>/庫存簡表列印於 2026\/10\/11，距今已 7 天.*失真/.test(w)));
  for(const kind of ['safety','dead','empty'] as const)assert.match(listSpec(kind,old,ctx).warning!,/^【警語】庫存簡表列印於 2026\/10\/11（距產生日 7 天），輸出結果可能失真。/);
  assert.deepEqual(derive([usage,stock],[],decisions,{y:2026,m:10,d:30}).stale.map(s=>s.kind),['inventory','usage']);
});
test('a main stock sheet and a separately printed supplement merge: each complete on its own, overlapping lines counted once from the later print',()=>{
  const item=(y:number,sku:string,name:string,location:string,qty:string):Cell[]=>[[sku,5,y],[name,95,y],['4710000'+sku,395,y],['A-測試',665,y],[location,745,y],[qty,840,y],['0',890,y]];
  // Without the three standard lines (y 140 to 180), with its own rows and print day.
  const sheet=(n:number,total:number,rows:Cell[],day='2026/10/11',standard=false)=>page(stockCells(n,total,'26北-測試店',rows).filter(c=>standard||![140,160,180].includes(c[2])).map(c=>c[0].startsWith('報表編號')?[c[0].replace('2026/10/11',day),c[1],c[2]] as Cell:c),700);
  const usage=parsed(usagePage(1,1),'usage',0,1);
  const main=[parsed(sheet(1,2,[],'2026/10/11',true),'inventory',1,1),parsed(sheet(2,2,[...item(150,'000700','C-新藥','B1','5')]),'inventory',1,2)];
  const supplement=parsed(sheet(1,1,[...item(150,'000206','C-30粒/盒EZETROL怡妥錠10MG','5脂41@','2,000'),...item(170,'000083','缺貨C-1000粒/盒(10粒/排)PENTOP循妥斯持續性錠400MG','3心16','368'),...item(190,'000800','C-補件藥','C9','7')],'2026/10/12'),'inventory',2,1);
  const data=derive([usage,...main,supplement],[],decisions,{y:2026,m:10,d:16});
  assert.deepEqual(data.blockers.filter(b=>b.includes('庫存簡表')),[]);
  assert.deepEqual(data.stockReports.map(r=>[r.pages.length,r.totals[0],r.missing.length]),[[2,2,0],[1,1,0]]);
  assert.equal(data.stockOverlap,2,'000206 and 000083 at the same locations');
  assert.deepEqual(data.stockRows.map(r=>[r.sku,r.qty]),[['000500','-2'],['000700','5'],['000206','2000'],['000083','368'],['000800','7']],'the later supplement wins 000206');
  assert.deepEqual(data.duplicates,[]);
  assert.match(data.warnings.join('\n'),/庫存簡表列印於 2026\/10\/11/,'the older sheet decides the print-date warning');
  // A supplement missing a page still blocks, named by its own page count.
  const partial=derive([usage,...main,parsed(sheet(1,2,item(150,'000800','C-補件藥','C9','7')),'inventory',2,1)],[],decisions,{y:2026,m:10,d:16});
  assert.ok(partial.blockers.includes('庫存簡表（第 2 份報表，共 2 頁）缺少第 2 頁（共 2 頁）；缺頁不能當成沒有資料'),partial.blockers.join('\n'));
  const other=derive([usage,...main,parsed(page(stockCells(1,1,'27北-別店'),700),'inventory',2,1)],[],decisions,{y:2026,m:10,d:16});
  assert.ok(other.blockers.some(b=>/各份庫存簡表不是同一門市/.test(b)));
});
test('a store with a partner clinic: more than 10 codes of the safety list without stock (no line or 0) are skipped and backfilled',()=>{
  const stock=parsed(fix(stockPage()),'inventory',1,1); // 000206, 000083, 000500
  // N = 120, 10% = 12. 000206 A = 50; `missing` codes without a stock line A = 25; 000083 A = 10; the rest A = 0.25.
  const usage=(missing:number)=>{const lines=[line(120,'000206','C-A','粒','200','200'),...Array.from({length:missing},(_,i)=>line(140+i*20,String(300000+i),`C-合作${i}`,'粒','100','100')),line(140+missing*20,'000083','C-B','粒','40','40'),
    ...Array.from({length:118-missing},(_,i)=>line(160+(missing+i)*20,String(400000+i),`C-品項${i}`,'粒','1','1'))];return parsed(page([...usageHead(1,1),...lines.flat()],2700),'usage',0,1);};
  const own=derive([usage(10),stock],[],decisions); // exactly 10 on the list: still our own stock, no acknowledgement required
  assert.equal(own.partner,undefined);assert.equal(own.safety!.k,12);assert.equal(own.missing.filter(m=>m.onList).length,10);assert.equal(own.available.safety,true);
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
  assert.deepEqual({...partner.safety!.outside,cover:undefined},{none:11,low:0,filled:1,cover:undefined});
  assert.ok(partner.missing.every(m=>!m.onList));assert.equal(partner.available.safety,true,'no acknowledgement needed');
  assert.ok(listRows('safety',partner).every(r=>r[2]!==NO_STOCK));
  const spec=listSpec('safety',partner,{files:{usage:['u.pdf'],inventory:['s.pdf']},version:1,appVersion:'test',time:'now'});
  assert.equal(spec.meta.length,3);assert.match(spec.meta[2],/合作診所供貨，略過無庫存 11、不足 0.1 月 0 筆，遞補 1 筆；取 K = 2 筆/);
  assert.equal(derive([usage(11)],[],decisions).partner,undefined,'no verdict before the stock sheet is read');
  assert.doesNotMatch(spec.note,/可能被略過/,'the default 0.1 mask carries no extra risk note');
  // The optional 0.2-month mask is printed on the list together with the purchase-need risk.
  const wide=derive([usage(11),stock],[],{...decisions,partnerCover:'wide'});
  const wideSpec=listSpec('safety',wide,{files:{usage:['u.pdf'],inventory:['s.pdf']},version:1,appVersion:'test',time:'now'});
  assert.match(wideSpec.meta[2],/不足 0.2 月/);assert.match(wideSpec.note,/遮罩放寬至 0.2 個月/);assert.match(wideSpec.note,/確需採購的品項也可能被略過/);
  assert.equal(derive([usage(10),stock],[],{...decisions,partnerCover:'wide'}).safety!.outside,undefined,'the choice does nothing without a partner clinic');
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
