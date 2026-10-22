import test from 'node:test';import assert from 'node:assert/strict';
import {aggregateStock,aggregateUsage,COLD_FACTOR,LOW_COVER,WIDE_COVER,overstock,assemble,coefficient,cmp,formatFrac,frac,longPeriod,matchStores,parseDay,parseDecimal,unheldOnList,partnerSupplied,PARTNER_LIMIT,SAFETY_STRATEGIES,safetyList,slotLists,disposition,statMonths,stockDuplicates,storeId,usageCodes,usageErrors,autoExclusion,type ReportPage,type SafetyStrategy,type StockRow,type UsageRow} from '../src/management-model';
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
test('dead stock and empty-slot duration threshold is strictly above 2.5 months',()=>{
  assert.equal(months('20260401','20260615'),'2.5');assert.equal(longPeriod(statMonths(day('20260401'),day('20260615'))!),false);
  assert.equal(longPeriod(statMonths(day('20260401'),day('20260616'))!),true);
  assert.equal(longPeriod(statMonths(day('20260616'),day('20260830'))!),false,'2 + 15/31 months');
});
test('coefficient by rank on the list: the top third 3.5, then linear down to 1.2 at the last row',()=>{
  const c=(i:number,k:number)=>formatFrac(coefficient(i,k,'hamster'),6);
  assert.deepEqual([c(0,106),c(35,106),c(36,106),c(105,106)],['3.5','3.5','3.467143','1.2'],'26永和: rows 1–36 at 3.5, as with the former A ≥ 30 (35 rows)');
  assert.deepEqual([c(0,4),c(1,4),c(2,4),c(3,4)],['3.5','3.5','2.35','1.2']);assert.equal(c(0,1),'3.5','a one-row list is all top third');
  const base=Array.from({length:27},(_,i)=>use(String(200000+i),1,1));
  const tie=safetyList(aggregateUsage([...base,use('000001',30,30),use('000002',20,20),use('000003',20,20)]).items,frac(1n),new Map(),false,'hamster');
  assert.deepEqual(tie.rows.map(r=>[r.sku,formatFrac(r.coefficient,6)]),[['000001','3.5'],['000002','2.925'],['000003','2.925']],'equal A, equal coefficient');
  const busy=safetyList(aggregateUsage([...base,use('000001',3000,3000),use('000002',2000,2000),use('000003',1000,1000)]).items,frac(1n),new Map(),false,'hamster');
  assert.deepEqual(busy.rows.map(r=>formatFrac(r.coefficient,6)),['3.5','2.925','1.2'],'A far above 30 no longer means 3.5 for everyone');
});
test('the attached example 000206: two lines added, A 41.25, B 26, A×B 1072.5, safety 3754',()=>{
  const summary=aggregateUsage([use('000206',67,1767),use('000206',98,2520)]);
  assert.equal(summary.items.length,1);assert.equal(formatFrac(summary.items[0].count),'165');assert.equal(formatFrac(summary.items[0].quantity),'4,287');
  const fill=Array.from({length:9},(_,i)=>use(String(200000+i),1,1)); // N = 10: a one-row list, so the top third
  const [row]=safetyList(aggregateUsage([...summary.items.flatMap(item=>item.rows),...fill]).items,frac(4n),aggregateStock([stock('000206',1990,'5脂41@','EZETROL怡妥錠10MG')]),false,'hamster').rows;
  assert.deepEqual([formatFrac(row.a),row.b,formatFrac(row.ab),formatFrac(row.coefficient),row.safety,formatFrac(row.stock!),row.name],['41.25',26n,'1,072.5','3.5',3754n,'1,990','EZETROL怡妥錠10MG']);
});
test('each strategy preserves the top-third plateau and a monotone exact gradient to its minimum',()=>{
  const expected={hamster:['3.5','3.5','2.35','1.2'],balanced:['2.5','2.5','1.65','0.8'],antelope:['1.2','1.2','0.9','0.6']};
  for(const strategy of Object.keys(SAFETY_STRATEGIES) as SafetyStrategy[]){
    const {maximum,minimum}=SAFETY_STRATEGIES[strategy];
    assert.deepEqual([0,1,2,3].map(i=>formatFrac(coefficient(i,4,strategy))),expected[strategy]);
    assert.equal(cmp(coefficient(0,1,strategy),maximum),0,'a single row receives the maximum');
    assert.equal(cmp(coefficient(35,106,strategy),maximum),0,'the boundary is included');
    assert.ok(cmp(coefficient(36,106,strategy),maximum)<0,'the next row falls below the plateau');
    assert.equal(cmp(coefficient(105,106,strategy),minimum),0);
    for(let i=1;i<106;i++)assert.ok(cmp(coefficient(i,106,strategy),coefficient(i-1,106,strategy))<=0);
    // Equal A at the tail still shares its first rank, rather than dropping to the minimum.
    const items=aggregateUsage([...Array.from({length:27},(_,i)=>use(String(200000+i),1,1)),use('000001',30,30),use('000002',20,20),use('000003',20,20)]).items;
    const result=safetyList(items,frac(1n),new Map(),false,strategy);
    assert.equal(cmp(result.rows[1].coefficient,result.rows[2].coefficient),0);
    assert.equal(safetyList(items.slice(0,9),frac(1n),new Map(),false,strategy).k,0);
  }
});
test('strategy coefficients use exact arithmetic at integer safety boundaries',()=>{
  const items=aggregateUsage([use('100001',50,4950),...Array.from({length:9},(_,i)=>use(String(200000+i),1,1))]).items;
  for(const [strategy,expected] of [['hamster',5775n],['balanced',4125n],['antelope',1980n]] as const)
    assert.equal(safetyList(items,frac(3n),new Map(),false,strategy).rows[0].safety,expected);
});
test('a 缺貨 name adds 1 to the rank coefficient on every strategy, without changing membership or rank',()=>{
  const base=Array.from({length:27},(_,i)=>use(String(500000+i),1,1));
  const items=aggregateUsage([...base,use('000001',30,30),use('000002',20,20),use('000003',10,10)]).items;
  const plain=aggregateStock([stock('000001',0,'A1','品一'),stock('000002',0,'A2','品二'),stock('000003',0,'A3','品三')]);
  const short=aggregateStock([stock('000001',0,'A1','品一'),stock('000002',0,'A2','缺貨 品二'),stock('000003',0,'A3','品三')]);
  for(const strategy of Object.keys(SAFETY_STRATEGIES) as SafetyStrategy[]){
    const a=safetyList(items,frac(1n),plain,false,strategy);const b=safetyList(items,frac(1n),short,false,strategy);
    assert.deepEqual(b.rows.map(r=>r.sku),a.rows.map(r=>r.sku));
    assert.deepEqual(b.rows.map(r=>r.shortage),[false,true,false]);
    assert.equal(cmp(b.rows[1].coefficient,frac(a.rows[1].coefficient.n+a.rows[1].coefficient.d,a.rows[1].coefficient.d)),0,strategy);
    assert.equal(cmp(b.rows[0].coefficient,a.rows[0].coefficient),0);assert.equal(cmp(b.rows[2].coefficient,a.rows[2].coefficient),0);
  }
  assert.deepEqual(safetyList(items,frac(1n),short,false,'hamster').rows.map(r=>r.safety),[105n,79n,12n],'hamster: 30 × 3.5, ceil(20 × 3.925), 10 × 1.2');
});
test('a 冷藏 name multiplies the coefficient by 0.8 after any 缺貨 bonus, without changing membership or rank',()=>{
  assert.equal(formatFrac(COLD_FACTOR),'0.8');
  const base=Array.from({length:27},(_,i)=>use(String(500000+i),1,1));
  const items=aggregateUsage([...base,use('000001',30,30),use('000002',20,20),use('000003',10,10)]).items;
  const plain=safetyList(items,frac(1n),aggregateStock([stock('000001',0,'A1','品一'),stock('000002',0,'A2','品二'),stock('000003',0,'A3','品三')]),false,'hamster');
  const cold=safetyList(items,frac(1n),aggregateStock([stock('000001',0,'A1','冷藏 品一'),stock('000002',0,'A2','缺貨冷藏 品二'),stock('000003',0,'A3','品三')]),false,'hamster');
  assert.deepEqual(cold.rows.map(r=>r.sku),plain.rows.map(r=>r.sku));
  assert.deepEqual(cold.rows.map(r=>[r.cold,r.shortage]),[[true,false],[true,true],[false,false]]);
  assert.deepEqual(cold.rows.map(r=>formatFrac(r.coefficient,6)),['2.8','3.14','1.2'],'3.5 × 0.8; (2.925 + 1) × 0.8; plain');
  assert.deepEqual(cold.rows.map(r=>r.safety),[84n,63n,12n],'30 × 2.8; ceil(20 × 3.14); 10 × 1.2');
  assert.deepEqual(plain.rows.map(r=>r.cold),[false,false,false]);
});
test('management keeps 冷藏 in front of the name, after 缺貨 whatever the report order; the inventory sheet still removes it',()=>{
  assert.equal(cleanProductName('冷藏 C-(紅)5 支/盒 Delta Pen 測試筆',true,['缺貨','冷藏']).name,'冷藏 Delta Pen測試筆');
  assert.equal(cleanProductName('冷藏缺貨 C-Theta 測試液 0.024% 2.5ML',true,['缺貨','冷藏']).name,'缺貨冷藏 Theta測試液0.024% 2.5ML');
  assert.equal(cleanProductName('停供冷藏C-50瓶/封CHLORAMPHENICOL眼藥水0.25% 5ML',true,['缺貨','冷藏']).name,'冷藏 CHLORAMPHENICOL眼藥水0.25% 5ML');
  assert.equal(cleanProductName('冷藏 C-(紅)5 支/盒 Delta Pen 測試筆',true).name,'Delta Pen測試筆');
});
test('partner clinic: the optional 0.2-month mask skips more low-stock codes and moves more codes up; 0.1 stays the default',()=>{
  assert.equal(formatFrac(WIDE_COVER),'0.2');
  const base=Array.from({length:25},(_,i)=>use(String(200000+i),1,1));
  // N = 30, limit 3; monthly use 000001 30, 000002 20, 000003 15, 000004 10, 000005 9.
  const items=aggregateUsage([...base,use('000001',30,30),use('000002',20,20),use('000003',15,15),use('000004',10,10),use('000005',9,9)]).items;
  // 000001 holds 5 (0.17 month): kept at 0.1, skipped at 0.2. 000002 holds 4 (exactly 0.2): kept by both.
  const stocked=aggregateStock([stock('000001',5),stock('000002',4),stock('000003',30),stock('000004',10),stock('000005',9)]);
  const standard=safetyList(items,frac(1n),stocked,true);
  assert.deepEqual(standard.rows.map(r=>r.sku),['000001','000002','000003']);assert.deepEqual(standard.outside,{none:0,low:0,filled:0,cover:LOW_COVER});
  const wide=safetyList(items,frac(1n),stocked,true,'hamster',WIDE_COVER);
  assert.deepEqual(wide.rows.map(r=>r.sku),['000002','000003','000004'],'000004 moves up; exactly 0.2 month is enough');
  assert.deepEqual(wide.outside,{none:0,low:1,filled:1,cover:WIDE_COVER});
  assert.equal(safetyList(items,frac(1n),stocked,false,'hamster',WIDE_COVER).rows.map(r=>r.sku).join(),'000001,000002,000003','no mask without a partner clinic');
});
test('stock above 4 months of use is overstock; exactly 4 months is not',()=>{
  const items=aggregateUsage([use('000001',10,100),use('000002',10,100),use('000003',10,100),use('000004',10,100)]).items; // A×B = 100 a month
  const result=safetyList(items,frac(1n),aggregateStock([stock('000001',400),stock('000002','400.5'),stock('000003',-5)]));
  assert.deepEqual(result.all.map(r=>overstock(r)),[false,true,false,false],'400 is not above 400; no stock line is never marked');
});
test('exact arithmetic: an integer safety value is not pushed up by float error; B rounds half up',()=>{
  // 3 months, 50 times, 4950 units: A = 50/3, B = 99, A × B × 3.5 = 5775 exactly; floats give 5775.000000000001.
  const a=50/3;assert.equal(Math.ceil(a*99*3.5),5776,'the float formula really is off here');
  const [row]=safetyList(aggregateUsage([use('100001',50,4950),...Array.from({length:9},(_,i)=>use(String(200000+i),1,1))]).items,frac(3n),new Map(),false,'hamster').rows;
  assert.equal(formatFrac(row.a),'16.67');assert.equal(row.b,99n);assert.equal(row.safety,5775n);
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
  assert.deepEqual(partner.outside,{none:2,low:0,filled:1,cover:LOW_COVER});
  assert.ok(partner.all.some(r=>r.sku==='000002'),'the skipped code is still calculated, only not listed');
  const short=safetyList(items,frac(1n),stocked,true);
  assert.deepEqual([short.limit,short.k],[3,2],'no backfill without another qualifying code; K never widens past A > 8');
  assert.deepEqual(short.outside,{none:1,low:0,filled:0,cover:LOW_COVER});
  // Monthly use: 000001 30 (stock 4 = 0.13 month), 000003 15, 000004 10, 000005 9.
  const zero=safetyList(more,frac(1n),aggregateStock([stock('000001',4),stock('000002',0),stock('000003',-2),stock('000004',3,'A1'),stock('000004',-3,'B1'),stock('000005','0.8')]),true);
  assert.deepEqual(zero.rows.map(r=>r.sku),['000001'],'0 and locations adding up to 0 are no stock; negative stock and 0.8 of 9 a month are under 0.1 month');
  assert.deepEqual(zero.outside,{none:2,low:2,filled:0,cover:LOW_COVER});
  assert.equal(safetyList(more,frac(1n),aggregateStock([stock('000001',3),stock('000003',2)]),true).rows.map(r=>r.sku).join(),'000001,000003','exactly 0.1 month (3 of 30) is enough');
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
  assert.deepEqual(lists.selfPay,[]);
});
test('self-pay lines (自費 anywhere in the status prefix) are set apart from dead stock and empty slots; at 0 they are not listed',()=>{
  const rows=[stock('099972',4,'D1','自費C-4粒/盒VIAGRA威而鋼膜衣錠100MG'),stock('165341',2,'A1','!自費A-4錠/盒Vedafil威達挺膜衣錠100MG'),
    stock('193671',0,'B1','換包自費C-14粒/盒Rozerem柔速瑞膜衣錠8MG'),stock('103529',1,'','停供自費避光C-(藥證已註銷)ATANAAL壓達能軟膠囊5MG'),
    stock('178361',5,'C1','自費C-28粒/盒Kerendia可申達膜衣錠20MG'),stock('000005',4,'A9','C-30粒/盒自費測試錠'),stock('000006',0,'A2','C-30粒/盒一般錠')];
  const lists=slotLists(rows,new Set(['178361']));
  assert.deepEqual(lists.selfPay.map(r=>r.sku),['165341','099972','103529'],'by location, blank last; a used self-pay code is in neither');
  assert.ok(!lists.empty.some(r=>r.sku==='193671'),'a self-pay line at 0 is not an empty slot either');
  assert.deepEqual(lists.dead.map(r=>r.sku),['000005'],'自費 inside the name after the marker is not the prefix');
  assert.deepEqual(lists.empty.map(r=>r.sku),['000006']);
});
test('dead stock to transfer (冷藏, 缺貨, 追追 prefix, then (管4), (管3)) leads the list in that order and is marked 轉調協銷; the rest 月初退倉',()=>{
  const rows=[stock('000001',3,'A1','C-30粒/盒一般錠'),stock('000002',2,'A2','C-30粒/盒管制錠5MG(管3)'),stock('000003',1,'A3','追追C-140粒/盒追追錠'),
    stock('000004',4,'Z9','冷藏避光C-10支/盒冷藏針'),stock('000005',5,'A0','C-30粒/盒管制錠2MG(管4)-高價藥'),stock('000006',6,'','缺貨C-60粒/盒缺貨錠'),
    stock('000007',7,'B1','冷藏C-1支/盒冷藏也缺(管4)'),stock('000008',8,'A0','C-30粒/盒近效錠')];
  const lists=slotLists(rows,new Set());
  assert.deepEqual(lists.dead.map(r=>r.sku),['000007','000004','000006','000003','000005','000002','000008','000001'],'the first mark decides the group; each group and the rest by location');
  assert.deepEqual(lists.dead.map(disposition),['轉調協銷','轉調協銷','轉調協銷','轉調協銷','轉調協銷','轉調協銷','月初退倉','月初退倉']);
  assert.equal(disposition(stock('000009',1,'','C-30粒/盒冷藏庫測試錠')),'月初退倉','冷藏 inside the name after the marker is not the prefix');
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
