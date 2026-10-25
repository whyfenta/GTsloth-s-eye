import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {loadNhi,match,rocDay,rocLabel,status,statusLabel,storeName} from '../scripts/nhi-match';
import {applyReview,csvText,decodeCsv,lookup,mapText,marksOf,paidSiblings,publicPathProblem,readMap,REVIEW_COLUMNS,type MapEntry} from '../scripts/sku-map';
import path from 'node:path';
import {parsePage,type ParsedPage} from '../src/management-parser';
import type {TextPage} from '../src/textlayer';

const HEADER=['藥品代號','藥品英文名稱','藥品中文名稱','成分','規格量','規格單位','支付價','有效起日','有效迄日','藥商','製造廠名稱','劑型','最後給付價','最後給付迄日'];
const row=(code:string,en:string,zh:string,ingredients:string,size:string,unit:string,price:string,start:string,end:string,firm:string,form:string)=>[code,en,zh,ingredients,size,unit,price,start,end,firm,firm,form,price,end];
const nhi=loadNhi(csvText([HEADER,
  row('AC45031100','IWELL TABLETS EVEREST','永勝宜胃錠','ALDIOXA 50 MG+MAGNESIUM 100 MG','','','1.5','1031201','9991231','永勝藥品','錠劑'),
  row('AC450311G0','IWELL TABLETS EVEREST','永勝宜胃錠','ALDIOXA 50 MG+MAGNESIUM 100 MG','','','2','1030801','9991231','永勝藥品','錠劑'),
  row('A045031100','IWELL TABLETS EVEREST','永勝宜胃錠','ALDIOXA 50 MG+MAGNESIUM 100 MG','','','0','1040101','9991231','永勝藥品','錠劑'),
  row('BC23373100','DIOVAN FILM-COATED TABLETS 80MG','得安穩膜衣錠80毫克','VALSARTAN 80 MG','','','9.3','1150401','9991231','台灣諾華','膜衣錠'),
  row('BC23109100','Co-Diovan 80/12.5 mg Film Coated Tablets','可得安穩 80/12.5 毫克膜衣錠','VALSARTAN 80 MG+HYDROCHLOROTHIAZIDE 12.5 MG','','','10','1150401','9991231','台灣諾華','膜衣錠'),
  row('BC20200321','ELOMET CREAM 0.1％','皚膚美得乳膏','MOMETASONE FUROATE 1 MG/GM','5','GM','24.4','1150401','9991231','歐嘉隆','乳膏劑'),
  row('BC20200335','ELOMET CREAM 0.1％','皚膚美得乳膏','MOMETASONE FUROATE 1 MG/GM','15','GM','60','1150401','9991231','歐嘉隆','乳膏劑'),
  row('BC20199321','ELOMET OINTMENT 0.1％','皚膚美得軟膏','MOMETASONE FUROATE 1 MG/GM','5','GM','24.4','1150401','9991231','歐嘉隆','軟膏劑'),
  row('AC13381100','Cortisone Acetate Tablets 25mg "Pine Lawer"','"柏理"乙酸可體松錠２５毫克','CORTISONE ACETATE 25 MG','','','1.5','1031001','9991231','柏理','錠劑'),
  row('AC46456100','CORTISONE ACETATE TABLETES 25MG "WEAL-CHANCE"','"韋淳"乙酸可體松錠25毫克','CORTISONE ACETATE 25 MG','','','1.5','1031001','9991231','韋淳','錠劑'),
  row('A023308100','HI-BESTON 50MG S.C. TABLETS','愛－必賜康糖衣錠５０毫克','THIAMINE 50 MG+RIBOFLAVIN 1 MG','','','0','950203','9991231','台灣田邊','糖衣錠'),
  row('B017121417','DURATEARS STERILE OPH OINT','淚膜眼藥膏','PETROLATUM 1 GM','3.5','GM','67','1150401','1151031','愛爾康','點眼膏劑'),
  row('B017121417','DURATEARS STERILE OPH OINT','淚膜眼藥膏','PETROLATUM 1 GM','3.5','GM','0','1151101','9991231','愛爾康','點眼膏劑'),
  row('AC14915329','FLUCORTONE OINTMENT "TAI YU"','膚露潤軟膏','FLUOCINOLONE 0.25 MG/GM','10','GM','40.5','1120401','9991231','台裕','軟膏劑'),
  row('AC60272421','"Wu Fu" Latropine Eye Drops 0.01％','"五福"樂托品點眼液0.01％','ATROPINE SULFATE .1 MG/ML','5','ML','29.9','1120801','9991231','五福','點眼液劑'),
  row('AC21491100','IZAN E.C. TABLETS 100MG (BROMELAIN) "LITA"','\'\'利達\'\'益腫腸溶錠100毫克（鳳梨酵素）','BROMELAIN 100 MG','','','1.5','1031001','9991231','利達','腸溶錠'),
  row('AC27557500','STATIN VAGINAL TABLETS 100000 UNITS "STANDARD" (NYSTATIN)','"生達" 速淨陰道錠１０萬單位（耐絲菌素）','NYSTATIN 100000 U (UNIT)','','','5','1040401','9991231','生達','錠劑'),
]));
const DAY='1151025';const TODAY='2026-10-25';
const IWELL_BOX='C-1000粒/盒(10粒/排)IWELL宜胃錠(複方)';const IWELL_BOTTLE='C-1000粒/瓶IWELL宜胃錠(複方)';
const pick=(raw:string)=>{const m=match(nhi,raw,DAY);return m.kind==='clear'?m.code:m.kind;};

test('NHI periods: paid on a day, scheduled stops, ROC dates',()=>{
  assert.equal(rocDay('2026-10-25'),'1151025');assert.equal(rocLabel('1151101'),'115/11/01');
  assert.equal(status(nhi.codes.get('AC450311G0')!,DAY).paid,true);assert.equal(status(nhi.codes.get('A045031100')!,DAY).paid,false);
  assert.deepEqual(status(nhi.codes.get('B017121417')!,DAY),{paid:true,price:67,stop:'1151101'});
  assert.equal(status(nhi.codes.get('B017121417')!,'1151101').paid,false);
  assert.equal(statusLabel(nhi.codes.get('B017121417'),DAY),'給付中 67 元，115/11/01 起停止給付');
  assert.equal(statusLabel(undefined,DAY),'健保檔無此碼');
  assert.deepEqual(paidSiblings(nhi,'A045031100',DAY).sort(),['AC45031100','AC450311G0']);
});

test('a store name keeps its package in the key but not its status words',()=>{
  const box=storeName(IWELL_BOX);
  assert.equal(box.key,'1000粒/盒(10粒/排)IWELL宜胃錠(複方)');assert.deepEqual(box.english,['IWELL']);assert.equal(box.core,'宜胃');
  assert.equal(box.pack,'G0');assert.equal(box.compound,true);assert.equal(box.form.base,'tablet');
  assert.equal(storeName('避光缺貨C-1000粒/盒(10粒/排)IWELL宜胃錠(複方)-高健保').key,box.key,'status words and -高健保 come and go');
  assert.notEqual(storeName(IWELL_BOTTLE).key,box.key,'a new package is a new name');assert.equal(storeName(IWELL_BOTTLE).pack,'00');
  assert.deepEqual(storeName('C-28粒/盒EXFORGE易安穩膜衣錠5/80MG').strengths.map(a=>[a.unit,a.value]),[['mg',5],['mg',80]]);
  const cream=storeName('C-ELOMET皚膚美得乳膏0.1% 5G(盒)');
  assert.deepEqual([cream.strengths,cream.sizes,cream.form.base,cream.form.topical],[[{unit:'%',value:0.1}],[{unit:'g',value:5}],'topical','乳膏']);
  const sachet=storeName('C-200包/盒ACTEIN愛克痰顆粒40MG(2.5G/包)(原Flucil福喜)');
  assert.deepEqual([sachet.form.base,sachet.sizes,sachet.core],['granule',[{unit:'g',value:2.5}],'愛克痰']);
  assert.equal(storeName('C-28粒/盒CLOPIDOGREL舒栓寧膜衣錠75MG').core,'舒栓寧','a form character inside the brand is kept');
  assert.equal(storeName('C-30粒/盒TULIP妥寧膜衣錠10MG[諾華]').maker?.includes('NOVARTIS'),true);
});

test('name matching picks one paid code, or says why it cannot',()=>{
  assert.equal(pick(IWELL_BOX),'AC450311G0','per 盒 with (10粒/排): the blister code');
  assert.equal(pick(IWELL_BOTTLE),'AC45031100','per 瓶: the plain code');
  assert.equal(pick('C-28粒/盒DIOVAN得安穩膜衣錠80MG'),'BC23373100','Co-Diovan 80/12.5 is not Diovan 80');
  assert.equal(pick('C-28粒/盒CO-DIOVAN可得安穩膜衣錠80/12.5MG'),'BC23109100');
  assert.equal(pick('C-ELOMET皚膚美得乳膏0.1% 5G(盒)'),'BC20200321','the 5 GM cream, not 15 GM or the ointment');
  assert.equal(pick('C-ELOMET皚膚美得乳膏0.1% 15G(盒)'),'BC20200335');
  assert.equal(pick('C-100粒/盒(10粒/排)CORTISONE乙酸可體松錠25MG'),'ambiguous','two firms print the same name');
  assert.equal(pick('自費C-100粒/盒(10粒/排)HI-BESTON愛-必賜康糖衣錠50MG(複方)'),'unpaid');
  assert.equal(pick('自費C-4粒/盒VIAGRA威而鋼膜衣錠100MG'),'none');
  assert.equal(pick('C-28粒/盒DIOVAN得安穩膜衣錠80MG[永信]'),'maker','the [廠牌] tag names another maker');
  const clear=match(nhi,IWELL_BOX,DAY);assert.equal(clear.candidates[0].code,'AC450311G0','the chosen code is listed first');
  assert.equal(pick('C-FLUCORT膚潤康乳膏0.025% 10G(紅)(盒)'),'none','a shortened English name alone is not enough: FLUCORT is not FLUCORTONE');
  assert.equal(pick('C-LATROPINE樂托品點眼液0.01% 5ML(盒)[五福]'),'AC60272421');
  assert.equal(pick('自費C-Latropine樂托品點眼液單支裝0.01%(30支/盒)(藍)[五福]'),'none','a unit-dose vial never takes the bottle code');
  assert.equal(pick('停供C-1000粒/瓶鳳梨酵素膜衣錠100MG(食品)[利達]'),'food','食品 have no 健保碼');
  assert.equal(pick('C-100粒/盒(10粒/排)STATIN速淨陰道錠10萬單位'),'AC27557500','the 劑型 says 錠劑, the name says 陰道錠');
  assert.deepEqual(storeName('冷藏C-6支/盒EPREX宜保利血注射液10000IU 4KIU/0.4ML').strengths.map(a=>[a.unit,a.value]),[['u',10000],['u/ml',10000],['u',4000]]);
});

const entry=(sku:string,code:string,key:string,verdict:MapEntry['verdict']='自動明確'):MapEntry=>({sku,code,key,verdict,date:'2026-10-01',source:'26北-永和福和店 2026-10-01 列印'});
test('the map file: header, spreadsheet damage put back, every problem reported',()=>{
  const header='六碼,健保藥品代號,對接品名,判定,判定日期,來源\n';
  assert.equal(readMap('﻿'+header).size,0);
  const map=new Map([['000019',entry('000019','AC450311G0','1000粒/盒(10粒/排)IWELL宜胃錠(複方)')],['099972',entry('099972','','4粒/盒VIAGRA威而鋼膜衣錠100MG','無健保碼')]]);
  assert.deepEqual(readMap(mapText(map)),map);
  assert.ok(mapText(map).startsWith('﻿六碼,'),'UTF-8 with BOM for spreadsheets');
  const excel=readMap(header+'19,ac450311g0,"1000粒/盒(10粒/排)IWELL宜胃錠(複方)",自動明確,2026/10/1,26北\n');
  assert.deepEqual(excel.get('000019'),{sku:'000019',code:'AC450311G0',key:'1000粒/盒(10粒/排)IWELL宜胃錠(複方)',verdict:'自動明確',date:'2026-10-01',source:'26北'});
  assert.throws(()=>readMap(header+'000019,AC450311G0,甲,猜的,2026-10-01,x\n000019,AC450311G0,甲,自動明確,2026-10-01,x\n000020,AC450311G0,乙,無健保碼,2026-10-01,x\n000021,,丙,人工確認,2026-10-01,x\n'),
    (e:Error)=>/4 個問題/.test(e.message)&&/判定應為/.test(e.message)&&/六碼重複/.test(e.message)&&/無健保碼不應填/.test(e.message)&&/應為 10 碼/.test(e.message));
  assert.throws(()=>readMap('六碼,健保碼\n'),/對照檔欄位應為/);
});

test('查表 first; matching only for new or renamed 六碼; a person decides what matching cannot',()=>{
  const item=(raw:string,sku='000019')=>({sku,rawName:raw,qty:'10',source:'15桃-蘆竹南崁店 2026-10-12 列印'});
  const fresh=lookup(item(IWELL_BOX),new Map(),nhi,DAY,TODAY);
  assert.deepEqual(fresh,{kind:'matched',entry:{sku:'000019',code:'AC450311G0',key:'1000粒/盒(10粒/排)IWELL宜胃錠(複方)',verdict:'自動明確',date:TODAY,source:'15桃-蘆竹南崁店 2026-10-12 列印'}});
  const map=new Map([['000019',fresh.kind==='matched'?fresh.entry:entry('','','')]]);
  assert.equal(lookup(item('缺貨C-1000粒/盒(10粒/排)IWELL宜胃錠(複方)'),map,nhi,DAY,TODAY).kind,'mapped','a new status word is the same name');
  const repacked=lookup(item(IWELL_BOTTLE),map,nhi,DAY,TODAY);
  assert.equal(repacked.kind,'matched');assert.equal(repacked.kind==='matched'&&repacked.entry.code,'AC45031100','an automatic answer follows the new package');
  const human=new Map([['000019',entry('000019','AC450311G0','1000粒/盒(10粒/排)IWELL宜胃錠(複方)','人工確認')]]);
  const asked=lookup(item(IWELL_BOTTLE),human,nhi,DAY,TODAY);
  assert.equal(asked.kind,'review');assert.equal(asked.kind==='review'&&asked.reason,'品名已變更','a person\'s verdict is never overwritten');
  const same=lookup(item('C-1000粒/盒(10粒/排)IWELL宜胃錠(複方)(新包裝)'),human,nhi,DAY,TODAY);
  assert.equal(same.kind,'renamed');assert.equal(same.kind==='renamed'&&same.entry.verdict,'人工確認','the same answer keeps the verdict and refreshes the name');
  const none=new Map([['099972',entry('099972','','4粒/盒VIAGRA威而鋼膜衣錠100MG','無健保碼')]]);
  assert.equal(lookup(item('自費C-8粒/盒VIAGRA威而鋼膜衣錠100MG','099972'),none,nhi,DAY,TODAY).kind,'renamed');
  const open=lookup(item('C-100粒/盒(10粒/排)CORTISONE乙酸可體松錠25MG','131580'),new Map(),nhi,DAY,TODAY);
  assert.equal(open.kind,'review');assert.equal(open.kind==='review'&&open.key,'100粒/盒(10粒/排)CORTISONE乙酸可體松錠25MG');
});

test('a filled-in review sheet becomes 人工確認 / 無健保碼, all or nothing',()=>{
  const sheet=(rows:string[][])=>csvText([REVIEW_COLUMNS,...rows.map(([sku,key,chosen])=>REVIEW_COLUMNS.map(name=>name==='六碼'?sku:name==='對接品名'?key:name==='採用'?chosen:name==='來源'?'26北':''))]);
  const map=new Map<string,MapEntry>();
  const result=applyReview(sheet([['131580','100粒/盒(10粒/排)CORTISONE乙酸可體松錠25MG','ac13381100'],['99972','4粒/盒VIAGRA威而鋼膜衣錠100MG','無'],['106508','4粒/盒CIALIS犀利士膜衣錠20MG','無健保碼'],['000001','某品名','']]),map,nhi,TODAY);
  assert.equal(result.skipped,1);
  assert.deepEqual([...map.values()].map(e=>[e.sku,e.code,e.verdict,e.date]),[['131580','AC13381100','人工確認',TODAY],['099972','','無健保碼',TODAY],['106508','','無健保碼',TODAY]]);
  assert.throws(()=>applyReview(sheet([['000002','乙','AC13381100'],['000003','丙','ZZ00000000']]),map,nhi,TODAY),/健保檔沒有 ZZ00000000/);
  assert.equal(map.size,3,'a bad sheet writes nothing');
  assert.equal(decodeCsv(new Uint8Array([164,187,189,88,44,177,196,165,206])),'六碼,採用','a sheet saved by Excel as Big5');
  assert.equal(marksOf('換包自費C-(停產)100粒/盒某藥錠'),'自費、停產');
});

test('the map stays out of this public repository',()=>{
  const root=process.cwd();
  assert.equal(publicPathProblem(root,path.resolve(root,'..','GTsloth-map','sku-nhi-map.csv')),undefined,'a sibling private repository');
  assert.equal(publicPathProblem(root,path.resolve(root,'docs','reference','sku-nhi-map.csv')),undefined,'ignored by sku-nhi-map*.csv');
  assert.equal(publicPathProblem(root,path.resolve(root,'output','map.csv')),undefined,'ignored by output/');
  assert.match(publicPathProblem(root,path.resolve(root,'docs','reference','map.csv'))??'',/commit 後就會公開/);
});

// The map lives in a private repository: set SKU_NHI_MAP to its sku-nhi-map.csv to check it against the NHI file.
test('the private map is well-formed and every 健保碼 in it is in the NHI file',t=>{
  const file=process.env.SKU_NHI_MAP;if(!file||!fs.existsSync(file))return t.skip('Set SKU_NHI_MAP to the private sku-nhi-map.csv.');
  const real=loadNhi(fs.readFileSync('docs/reference/nhi-drug-codes.csv','utf8'));const map=readMap(fs.readFileSync(file,'utf8'));
  for(const e of map.values())if(e.code)assert.ok(real.codes.has(e.code),`${e.sku} ${e.code}`);
});

// The attached 26 永和福和店 庫存簡表 stays private: set MANAGEMENT_INVENTORY_PDF to run this one.
test('26 永和福和店 template: 955 of 1,002 六碼 match one paid code as of 115/10/25',async t=>{
  const file=process.env.MANAGEMENT_INVENTORY_PDF;if(!file||!fs.existsSync(file))return t.skip('Set MANAGEMENT_INVENTORY_PDF to the private 26 永和福和店 庫存簡表.');
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc=await pdfjs.getDocument({data:new Uint8Array(fs.readFileSync(file)),verbosity:0}).promise;const names=new Map<string,string>();
  for(let n=1;n<=doc.numPages;n++){const page=await doc.getPage(n);const vp=page.getViewport({scale:300/72});const ops=await page.getOperatorList();const content=await page.getTextContent();
    const text:TextPage={viewport:vp.transform,width:Math.ceil(vp.width),height:Math.ceil(vp.height),hasImages:ops.fnArray.some(f=>f===pdfjs.OPS.paintImageXObject),items:content.items.flatMap((i:any)=>'str' in i?[{str:i.str,transform:i.transform,width:i.width}]:[])};
    const r=parsePage(text,'inventory',0,n);assert.ok(r.ok);for(const s of (r as {page:ParsedPage}).page.stock)if(/^\d{6}$/.test(s.sku)&&!names.has(s.sku))names.set(s.sku,s.rawName);}
  const real=loadNhi(fs.readFileSync('docs/reference/nhi-drug-codes.csv','utf8'));const kinds:Record<string,number>={};const codes=new Map<string,string>();
  for(const [sku,raw] of names){const m=match(real,raw,DAY);kinds[m.kind]=(kinds[m.kind]??0)+1;if(m.kind==='clear')codes.set(sku,m.code);}
  assert.deepEqual(kinds,{clear:955,ambiguous:9,unpaid:2,none:36});
  const expected:Record<string,string>={'000019':'AC450311G0','000041':'BC22882100','000131':'BC24047100','000152':'BC23481157','003283':'BC20200321','105517':'BC23373100','123691':'BC25114100','139608':'BC030781G0','153959':'BC27473100','159041':'KC01107210'};
  for(const [sku,code] of Object.entries(expected))assert.equal(codes.get(sku),code,sku);
});
