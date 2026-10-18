import test from 'node:test';import assert from 'node:assert/strict';
import {aggregateStock,aggregateUsage,assemble,coefficient,formatFrac,frac,longPeriod,matchStores,parseDay,parseDecimal,unheldOnList,partnerSupplied,PARTNER_LIMIT,safetyList,slotLists,statMonths,stockDuplicates,storeId,usageCodes,usageErrors,autoExclusion,type ReportPage,type StockRow,type UsageRow} from '../src/management-model';
import {cleanProductName} from '../src/model';
const day=(text:string)=>parseDay(text)!;
const months=(a:string,b:string)=>{const m=statMonths(day(a),day(b));return m&&formatFrac(m,6);};
const origin={file:0,filePage:1,reportPage:1,top:0,bottom:0};
let id=0;
const use=(sku:string,count:string|number,quantity:string|number,unit='粒',extra:Partial<UsageRow>={}):UsageRow=>({id:`u${id++}`,origin,sku,rawName:`品項${sku}`,unit,count:String(count),quantity:String(quantity),notes:[],reviewed:true,excluded:autoExclusion(sku),...extra});
const stock=(sku:string,qty:string|number,location='',name=`庫存${sku}`):StockRow=>({id:`s${id++}`,origin,sku,rawName:name,name,location,qty:String(qty),notes:[],reviewed:true});

test('calendar months: the attached period is exactly 4; partial months use the anchor month length, not 30 days',()=>{
  assert.equal(months('20260616','20261015'),'4');
  assert.equal(months('20260101','20260315'),'2.483871','2 months + 15/31');
  assert.equal(months('20260101','20260131'),'1');
  assert.equal(months('20260131','20260227'),'1','1/31 anchors on 2/28 in a common year');
  assert.equal(months('20240131','20240228'),'1','leap year: 2/29 is the anchor');
  assert.equal(months('20240131','20240229'),'1.032258','one day past the 2/29 anchor, of the 31-day segment to 3/31');
  assert.equal(months('20260131','20260330'),'2','3/31 is the second anchor (original day 31 restored)');
  assert.equal(months('20261015','20261015'),'0.032258','one day of a 31-day segment');
  assert.equal(statMonths(day('20261015'),day('20261014')),null);
  assert.equal(parseDay('20260230'),null);
});
test('dead stock and empty slots open only strictly above 2.5 months',()=>{
  assert.equal(months('20260401','20260615'),'2.5');assert.equal(longPeriod(statMonths(day('20260401'),day('20260615'))!),false);
  assert.equal(longPeriod(statMonths(day('20260401'),day('20260616'))!),true);
  assert.equal(longPeriod(statMonths(day('20260616'),day('20260830'))!),false,'2 + 15/31 months');
});
test('coefficient: 1.2 at 8, linear to 3.5 at 30, fixed above',()=>{
  assert.equal(formatFrac(coefficient(frac(8n)),6),'1.2');assert.equal(formatFrac(coefficient(frac(19n)),6),'2.35');
  assert.equal(formatFrac(coefficient(frac(30n)),6),'3.5');assert.equal(formatFrac(coefficient(frac(4125n,100n)),6),'3.5');
});
test('the attached example 000206: two lines added, A 41.25, B 26, A×B 1072.5, safety 3754',()=>{
  const summary=aggregateUsage([use('000206',67,1767),use('000206',98,2520)]);
  assert.equal(summary.items.length,1);assert.equal(formatFrac(summary.items[0].count),'165');assert.equal(formatFrac(summary.items[0].quantity),'4,287');
  const [row]=safetyList(summary.items,frac(4n),aggregateStock([stock('000206',1990,'5脂41@','EZETROL怡妥錠10MG')])).all;
  assert.deepEqual([formatFrac(row.a),row.b,formatFrac(row.ab),formatFrac(row.coefficient),row.safety,formatFrac(row.stock!),row.name],['41.25',26n,'1,072.5','3.5',3754n,'1,990','EZETROL怡妥錠10MG']);
});
test('exact arithmetic: an integer safety value is not pushed up by float error; B rounds half up',()=>{
  // 3 months, 50 times, 4950 units: A = 50/3, B = 99, A × B × coefficient = 3475 exactly; floats give 3475.0000000000005.
  const a=50/3;assert.equal(Math.ceil(a*99*(1.2+(a-8)*2.3/22)),3476,'the float formula really is off here');
  const [row]=safetyList(aggregateUsage([use('100001',50,4950)]).items,frac(3n),new Map()).all;
  assert.equal(formatFrac(row.a),'16.67');assert.equal(row.b,99n);assert.equal(row.safety,3475n);
  assert.equal(safetyList(aggregateUsage([use('100002',40,100)]).items,frac(4n),new Map()).all[0].b,3n,'2.5 rounds to 3');
  assert.equal(safetyList(aggregateUsage([use('100003',40,98)]).items,frac(4n),new Map()).all[0].b,2n,'2.45 rounds to 2');
  assert.equal(parseDecimal('1,240')?.n,1240n);assert.equal(formatFrac(parseDecimal('-0.5')!),'-0.5');assert.equal(parseDecimal('12 34'),null);
});
test('K = min(floor(10% of N), items with A > 8); A = 8 is out, ties sort by code without widening K',()=>{
  const items=(rows:UsageRow[])=>aggregateUsage(rows).items;
  const base=Array.from({length:18},(_,i)=>use(String(200000+i),1,1));
  // A = count / 1 month.
  const result=safetyList(items([...base,use('000003',9,9),use('000002',9,9),use('000001',8,8)]),frac(1n),new Map());
  assert.equal(result.n,21);assert.equal(result.limit,2);assert.equal(result.eligible,2);assert.deepEqual(result.rows.map(r=>r.sku),['000002','000003']);
  const tie=safetyList(items([...base,use('000003',9,9),use('000002',9,9),use('000004',9,9)]),frac(1n),new Map());
  assert.equal(tie.k,2);assert.deepEqual(tie.rows.map(r=>r.sku),['000002','000003'],'the third tied item is not added');
  const few=safetyList(items([use('000001',50,50),use('000002',40,40)]),frac(1n),new Map());
  assert.equal(few.n,2);assert.equal(few.k,0,'fewer than 10 items: floor(10%) is 0, no minimum of 1');
  assert.equal(safetyList(items([...base,use('000005',8001,8001),use('000006',0,0)]).map(i=>({...i})),frac(1000n),new Map()).rows[0]?.sku,'000005','A = 8.001 qualifies');
});
test('partner clinic: more than 10 codes of the ordinary safety list without a stock line',()=>{
  assert.equal(PARTNER_LIMIT,10);assert.equal(partnerSupplied(10),false,'exactly 10 is not enough');assert.equal(partnerSupplied(11),true);assert.equal(partnerSupplied(2),false,'26永和: 2');
  const items=aggregateUsage([...Array.from({length:27},(_,i)=>use(String(200000+i),1,1)),use('000001',30,30),use('000002',20,20),use('000003',15,15)]).items;
  assert.equal(unheldOnList(safetyList(items,frac(1n),aggregateStock([stock('000001',4),stock('000003',0)]))),2,'a zero-stock line counts as no stock');
});
test('partner clinic: codes the store holds no stock of are skipped and later codes move up; N and the 10% target stay',()=>{
  const base=Array.from({length:27},(_,i)=>use(String(200000+i),1,1));
  // N = 30, limit 3; A > 8: 000001 (30) 000002 (20, no stock line) 000003 (15) 000004 (10) 000005 (9, zero stock line).
  const items=aggregateUsage([...base,use('000001',30,30),use('000002',20,20),use('000003',15,15)]).items;
  const more=aggregateUsage([...base.slice(2),use('000001',30,30),use('000002',20,20),use('000003',15,15),use('000004',10,10),use('000005',9,9)]).items;
  const stocked=aggregateStock([stock('000001',4),stock('000003',2),stock('000004',1),stock('000005',0)]);
  const plain=safetyList(more,frac(1n),stocked);assert.deepEqual(plain.rows.map(r=>r.sku),['000001','000002','000003']);assert.equal(plain.outside,undefined);
  const partner=safetyList(more,frac(1n),stocked,true);
  assert.deepEqual([partner.n,partner.limit,partner.eligible,partner.k],[30,3,3,3],'000005 at 0 stock is not eligible either');
  assert.deepEqual(partner.rows.map(r=>r.sku),['000001','000003','000004'],'000004 moves up into the place of 000002');
  assert.deepEqual(partner.outside,{eligible:2,filled:1});
  assert.ok(partner.all.some(r=>r.sku==='000002'),'the skipped code is still calculated, only not listed');
  const short=safetyList(items,frac(1n),stocked,true);
  assert.deepEqual([short.limit,short.k],[3,2],'no backfill without another qualifying code; K never widens past A > 8');
  assert.deepEqual(short.outside,{eligible:1,filled:0});
  const zero=safetyList(more,frac(1n),aggregateStock([stock('000001',4),stock('000002',0),stock('000003',-2),stock('000004',3,'A1'),stock('000004',-3,'B1')]),true);
  assert.deepEqual(zero.rows.map(r=>r.sku),['000001','000003'],'0 and locations adding up to 0 are no stock; a negative total is still ours');
});
test('usage rows: invalid values are review items, never zero; non-six-digit codes are excluded records outside N',()=>{
  assert.deepEqual(usageErrors(use('000001','-1','2')),['次數為負數']);
  assert.deepEqual(usageErrors(use('000001','1.5','2')),['次數必須是整數']);
  assert.deepEqual(usageErrors(use('000001','','2','')),['缺少次數','缺少單位']);
  assert.deepEqual(usageErrors(use('','1','2')),['缺少醫品編號']);
  const rows=[use('R001',1,1,''),use('000001',0,0),use('000002',1,1),use('',3,3)];
  assert.match(rows[0].excluded!,/R001/);assert.equal(rows[3].excluded,undefined,'a row without any code stays for review');
  const summary=aggregateUsage(rows);assert.deepEqual(summary.items.map(i=>i.sku),['000001','000002']);assert.equal(summary.invalid.length,1);
  assert.deepEqual([...usageCodes(rows)],['000001','000002'],'a zero count is still in the report');
});
test('one code with two units is a conflict, not a sum',()=>{
  const summary=aggregateUsage([use('000001',1,10,'粒'),use('000001',1,1,'盒'),use('000002',1,1,'瓶'),use('000002',2,2,'瓶')]);
  assert.deepEqual(summary.unitConflicts.map(c=>[c.sku,c.units]),[['000001',['粒','盒']]]);assert.equal(formatFrac(summary.items[1].count),'3');
});
test('stock: locations add up per code, the first name is kept; same code + location twice is held back',()=>{
  const rows=[stock('000001',5,'A1','第一名稱'),stock('000001',-2,'B1','第二名稱'),stock('000002',3,'A1'),stock('000002',3,'A 1')];
  const items=aggregateStock(rows);assert.equal(formatFrac(items.get('000001')!.qty),'3');assert.equal(items.get('000001')!.name,'第一名稱');
  assert.deepEqual(stockDuplicates(rows).map(list=>list.map(r=>r.location)),[['A1','A 1']]);
});
test('dead stock (≠ 0, incl. negative) and empty slots (= 0) only for codes outside the usage report, by location with blanks last',()=>{
  const rows=[stock('000001',3,'B2'),stock('000002',0,'A1'),stock('000003',-1,''),stock('000004',2,'A10'),stock('000005',4,'A9'),stock('000006',0,''),stock('000007',0,'A2')];
  const lists=slotLists(rows,new Set(['000004','000007']));
  assert.deepEqual(lists.dead.map(r=>[r.sku,r.negative]),[['000005',false],['000001',false],['000003',true]]);
  assert.deepEqual(lists.empty.map(r=>r.sku),['000002','000006']);
});
test('store identity: number and name must agree; different numbers are never the same store',()=>{
  const usage=storeId('26永和福和店','0026');const sheet=storeId('26北-永和福和店');
  assert.equal(matchStores(usage,sheet),'same');
  assert.equal(matchStores(usage,storeId('27北-永和福和店')),'different');
  assert.equal(matchStores(usage,storeId('26北-中和店')),'unsure');
  assert.equal(matchStores(usage,storeId('永和福和店')),'unsure','a title without a store number needs a person');
  assert.equal(matchStores(storeId('27永和福和店','0026'),sheet),'different','code and title of one report disagree');
});
test('page assembly: an identical repeated page counts once, a different page with the same number blocks, gaps are listed',()=>{
  const page=(file:number,filePage:number,reportPage:number,signature='x',reportTotal=4):ReportPage=>({key:`${file}-${filePage}`,file,filePage,reportPage,reportTotal,signature,meta:'m'});
  const result=assemble([page(0,1,1),page(0,2,2),page(1,1,2),page(1,2,4,'y')]);
  assert.deepEqual(result.pages.map(p=>p.reportPage),[1,2,4]);assert.equal(result.duplicates.length,1);assert.deepEqual(result.missing,[3]);assert.equal(result.conflicts.length,0);
  assert.equal(assemble([page(0,1,1),page(1,1,1,'other')]).conflicts.length,1);
});
test('management keeps 缺貨 and still removes what follows it; the inventory sheet still removes it',()=>{
  const raw='缺貨C-1000粒/盒(10粒/排)PENTOP循妥斯持續性錠400MG';
  assert.equal(cleanProductName(raw,true,['缺貨']).name,'缺貨 PENTOP循妥斯持續性錠400MG');
  assert.equal(cleanProductName(raw,true).name,'PENTOP循妥斯持續性錠400MG');
  assert.equal(cleanProductName('避光缺貨C-100粒/瓶TEST錠(管4)-高價藥',true,['缺貨']).name,'缺貨 TEST錠(管4)');
  assert.equal(cleanProductName('C-SERETIDE EVO使肺泰250',true,['缺貨']).name,'SERETIDE EVO使肺泰250');
});
