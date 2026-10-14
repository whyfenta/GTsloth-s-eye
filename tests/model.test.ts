import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { admit, canonicalQuantity, cleanProductName, sortRows, canExport, dropZeroRows, emptyBox, hasDoubt, isZeroQuantity, needsIndividualReview, normalizeOCR, formatQuantity, type InventoryRow } from '../src/model';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { barcodeBits, barcodeFontText, mm, PRINT, wrapText } from '../src/pdf';
import fontkit from '@pdf-lib/fontkit';
const row=(sku:string,location='',bookQty='1'):InventoryRow=>({id:sku,page:1,sku,rawName:'品項',name:'品項',location,bookQty,boxes:{sku:emptyBox,rawName:emptyBox,location:emptyBox,bookQty:emptyBox},confidence:{sku:100,rawName:100,location:100,bookQty:100},issues:[],reviewed:true,attention:false});
test('leading prefix grammar preserves dose, internal package text, and controlled suffix',()=>{
  const cases=[
    ['換包C-&500粒/盒(10粒/排)FELIPINE福必源錠0.25MG(管4)','FELIPINE福必源錠0.25MG(管4)'],
    ['近效C-(2027.08)&100粒/盒(10粒/排):XANAX XR贊安諾持續錠0.5MG(管4)','XANAX XR贊安諾持續錠0.5MG(管4)'],
    ['近效(2027.10)C-&30粒/瓶CONCERTA專思達長效錠18MG(管3)','CONCERTA專思達長效錠18MG(管3)'],
    ['冷藏避光C-&10支/盒測試商品10MG(複方)(管3)','測試商品10MG(複方)(管3)'],
    ['缺貨C-&60粒/盒(10粒/排)RIVOTRIL利福全錠2MG(管4)','RIVOTRIL利福全錠2MG(管4)'],
    ['TEST-包裝單位10粒名稱0.5MG','TEST-包裝單位10粒名稱0.5MG'],
  ];for(const [raw,expected]of cases)assert.equal(cleanProductName(raw).name,expected);
  const damaged=cleanProductName('C-&100爛/交損壞名稱');assert.equal(damaged.name,'損壞名稱');assert.ok(damaged.notes.some(n=>n.includes('100爛/交')));
});
test('source quantities: grouping, zero, signed decimals; never guess malformed digit strings',()=>{
  assert.equal(canonicalQuantity('4,240'),'4240');assert.equal(canonicalQuantity('0'),'0');assert.equal(canonicalQuantity('-12.50'),'-12.50');
  assert.equal(canonicalQuantity('1,24'),null);assert.equal(canonicalQuantity('O22'),null);assert.equal(canonicalQuantity(''),null);
});
test('safe zero filtering recognises zero spellings, preserves negatives and retains uncertain zeroes',()=>{
  for(const value of ['0','-0','0.00','000'])assert.equal(isZeroQuantity(value),true,value);
  assert.equal(isZeroQuantity('-1'),false);
  const uncertain={...row('000003','', '0'),issues:['庫存量格式待確認']};
  const {kept,skipped}=dropZeroRows([row('000001','','0'),row('000002','', '-2'),uncertain]);
  assert.deepEqual(kept.map(item=>item.sku),['000002','000003']);assert.deepEqual(skipped.map(item=>item.sku),['000001']);
});
test('natural location order, code tie break, blank last, duplicates retained',()=>{
  const rows=[row('000003','L10'),row('000002','L2'),row('000001','L2'),row('000004','')];
  assert.deepEqual(sortRows(rows,'location').map(r=>r.sku),['000001','000002','000003','000004']);
  const duplicate=row('000001','L11');assert.equal(sortRows([...rows,duplicate],'sku').length,5);
});
test('export blocks unfinished jobs, rejected pages, unreviewed and malformed rows',()=>{
  const pages=[{page:1,width:100,height:100,rotation:0,deskew:0,status:'accepted' as const,reason:'',rowCount:1,skippedZero:0,storeName:''}];
  assert.equal(canExport([row('000001')],pages,true),true);assert.equal(canExport([row('000001')],pages,false),false);assert.equal(canExport([row('000001','', '0')],pages,true),false);
  assert.equal(canExport([{...row('000001'),reviewed:false}],pages,true),false);assert.equal(canExport([row('00001')],pages,true),false);
  assert.equal(canExport([row('000001')],[{...pages[0],status:'rejected'}],true),false);
});
test('expiry dates are removed only in leading prefix position',()=>{
  assert.equal(cleanProductName('近效2026/11/01 C-&100粒/盒 PRODUCT 5MG(管4)').name,'PRODUCT 5MG(管4)');
  assert.equal(cleanProductName('近效(2026.11)C-: PRODUCT 5MG').name,'PRODUCT 5MG');
  assert.equal(cleanProductName('PRODUCT 2026/11/01 5MG').name,'PRODUCT 2026/11/01 5MG');
});
test('Code128C six digits retains zeros and exactly fits print quiet zone',()=>{
  assert.equal(barcodeBits('000001').length,68);assert.notEqual(barcodeBits('000001'),barcodeBits('000010'));
  assert.throws(()=>barcodeBits('00001'));assert.equal(barcodeFontText('000001').length,6);
  assert.ok(68*PRINT.moduleWidth+20*PRINT.moduleWidth<=PRINT.columns[0]);assert.equal(PRINT.columns.reduce((a,b)=>a+b,0),190);
  assert.equal(PRINT.skuSize,16);assert.equal(PRINT.nameSize,16);assert.equal(PRINT.quantitySize,20);assert.deepEqual(PRINT.headerFill,[.84,.90,.86]);assert.deepEqual(PRINT.alternatingRowFill,[.92,.95,.93]);
  // Blank count column must still fit nine handwritten digits (~4 mm each).
  assert.ok(PRINT.columns[4]>=9*4+4);
});
test('all local visually transcribed source names clean to their expected values',t=>{
  if(!fs.existsSync('tests/fixtures/sample-gold.json'))return t.skip('Private source fixture is deliberately not published in the repository.');
  const fixture=JSON.parse(fs.readFileSync('tests/fixtures/sample-gold.json','utf8'));
  assert.equal(fixture.length,61);for(const record of fixture)assert.equal(cleanProductName(record.rawName).name,record.cleanName,record.sku);
});
test('field-test prefixes: status words, damaged C- marker, tags and unknown status before C-',()=>{
  const cases:[string,string][]=[
    ['停供冷藏(-5 支/盒 ALPHA 測試筆 300IU/3ML','ALPHA測試筆300IU/3ML'],
    ['換包冷藏 C-BETA 測試眼藥水 2.5ML(黃盒)','BETA測試眼藥水2.5ML(黃盒)'],
    ['冷藏自費 C-Gamma 測試環','Gamma測試環'],
    ['冷藏 C-(紅)5 支/盒 Delta Pen 測試筆 - 混合型 50(100U/ML)','Delta Pen測試筆-混合型50(100U/ML)'],
    ['冷藏客訂 C-25 粒/瓶 EPS 測試錠 2MG','EPS測試錠2MG'],
    ['冷藏 -30 支/盒 ZETA-S 測試 0.0015%(單支調劑用)','ZETA-S測試0.0015%(單支調劑用)'],
    ['不售冷藏 --(贈藥)ETA 測試劑 40MG 0.4ML(針筒裝)(盒)','ETA測試劑40MG 0.4ML(針筒裝)(盒)'],
    ['缺貨冷藏 C-Theta 測試液 0.024% 2.5ML','Theta測試液0.024% 2.5ML'],
  ];
  for(const [raw,expected] of cases){const result=cleanProductName(raw);assert.equal(result.name,expected,raw);assert.equal(result.uncertain,false,raw);}
  const damaged=cleanProductName('冷藏(-50 瓶/盒 IOTA 測試水');assert.equal(damaged.name,'IOTA測試水');assert.ok(damaged.notes.some(n=>n.includes('誤辨')));
  const unknown=cleanProductName('冷藏追追些售 C-1 支/盒 KAPPA 測試劑 2MG');assert.equal(unknown.name,'KAPPA測試劑2MG');assert.ok(unknown.notes.some(n=>n.includes('些售')));
  assert.equal(cleanProductName('冷藏-(紅)5 支/盒 MU 測試筆').name,'MU測試筆');
  assert.equal(cleanProductName('(紅)5支/盒NU測試筆').uncertain,true);
  const fuzzy=cleanProductName('C-&1000粒/會(10和粒/排)OMEGA測試錠0.5MG(管4)');assert.equal(fuzzy.name,'OMEGA測試錠0.5MG(管4)');assert.ok(fuzzy.notes.some(n=>n.includes('包裝規格')));
  assert.equal(cleanProductName('C-&100粒/盒(10和粒/排)PSI測試錠').name,'PSI測試錠');
  assert.equal(cleanProductName('(10粒/排)PSI測試錠').uncertain,true);
  // Without a preceding marker a digit/han/han start is not assumed to be a package.
  assert.equal(cleanProductName('3號/盒OMEGA').name,'3號/盒OMEGA');
  // A misread marker letter after a status is never silently accepted as the name.
  assert.equal(cleanProductName('冷藏 L-LAMBDA 測試水(紫盒)').uncertain,true);
});
test('the report marker C- is removed even without a status; real hyphenated names are untouched',()=>{
  // The system-printed report puts C- before ~45 names with no status (C-SERETIDE, C-TIMOPTOL...).
  const bare=cleanProductName('C-SERETIDE EVO倍肺泰250優氟吸入劑');assert.equal(bare.name,'SERETIDE EVO倍肺泰250優氟吸入劑');assert.equal(bare.uncertain,false);
  assert.deepEqual(cleanProductName('L-THYROXINE 50MCG'),{name:'L-THYROXINE 50MCG',removed:[],uncertain:false,notes:[]});
  assert.equal(cleanProductName('Vitamin C-500').name,'Vitamin C-500');
});
test('OCR spaces next to Chinese text are removed, Latin/number spacing kept',()=>{
  assert.equal(normalizeOCR('ALPHA 測試錠 0.25MG(管 4)'),'ALPHA測試錠0.25MG(管4)');
  assert.equal(normalizeOCR('XANAX XR 贊安諾 40MG 0.4ML'),'XANAX XR贊安諾40MG 0.4ML');
  assert.equal(normalizeOCR('冰 U'),'冰U');assert.equal(normalizeOCR('SML(裸)[ 吾輝 ]- 高健保'),'SML(裸)[吾輝]-高健保');
});
test('trailing -高健保 / -高價藥 tags are removed; other suffixes and look-alike text stay',()=>{
  assert.equal(cleanProductName('SML(裸)[ 吾輝 ]- 高健保').name,'SML(裸)[吾輝]');
  const chain=cleanProductName('C-&28粒/盒測試錠10MG-高健保-高價藥',true);
  assert.equal(chain.name,'測試錠10MG');assert.deepEqual(chain.removed.slice(-2),['-高健保','-高價藥']);assert.equal(chain.uncertain,false);
  assert.equal(cleanProductName('測試錠10MG-高價藥-改192909',true).name,'測試錠10MG-改192909');
  assert.equal(cleanProductName('測試錠-高價藥組',true).name,'測試錠-高價藥組');assert.equal(cleanProductName('高價藥測試錠',true).name,'高價藥測試錠');
  // A removed suffix is not a removed prefix, so an OCR name like L-THYROXINE is not flagged.
  assert.equal(cleanProductName('L-THYROXINE 50MCG-高健保').uncertain,false);
  assert.equal(cleanProductName('C-&10粒/盒-高價藥',true).uncertain,true,'nothing left of the name');
});
test('quantities with inner spaces are rejected and leading zeros normalised',()=>{
  assert.equal(canonicalQuantity('12 34'),null);assert.equal(canonicalQuantity(' 1,234 '),'1234');
  assert.equal(canonicalQuantity('0012'),'12');assert.equal(formatQuantity('0012'),'12');assert.equal(canonicalQuantity('0.50'),'0.50');
});
test('page confirmation leaves prefix/code doubts for individual review',()=>{
  assert.equal(needsIndividualReview({issues:['名稱前綴無法完整解析']}),true);
  assert.equal(needsIndividualReview({issues:['此列範圍內有多個代號或庫存量，可能合併了兩筆商品']}),true);
  assert.equal(needsIndividualReview({issues:['名稱辨識品質差，請逐字核對原圖','儲位空白，請確認原表']}),false);
});
test('only meaningful issues enter the consolidated doubt queue',()=>{
  assert.equal(hasDoubt({...row('000001'),issues:['包裝規格疑似誤辨「10粒/會」，已依格式移除，請確認']}),false);
  const rows=admit([row('000001'),{...row('000002'),issues:['庫存量格式待確認']}]);
  assert.deepEqual(rows.map(item=>[item.attention,item.reviewed]),[[false,true],[true,false]]);
});
test('PDF wrapping keeps units and brackets together',async()=>{
  const font=await (await PDFDocument.create()).embedFont(StandardFonts.Courier);const width=font.widthOfTextAtSize('X'.repeat(14),10);
  assert.deepEqual(wrapText('LEVEMIR PEN 300IU/3ML',font,10,width),['LEVEMIR PEN','300IU/3ML']);
  assert.deepEqual(wrapText('ABCDEFGHIJKL (BOX)',font,10,width),['ABCDEFGHIJKL','(BOX)']);
  assert.deepEqual(wrapText('X'.repeat(20),font,10,width),['X'.repeat(14),'X'.repeat(6)]);
});
test('CJK names wrap without splitting (管4) or (黃盒)',async()=>{
  const document=await PDFDocument.create();document.registerFontkit(fontkit);
  const noto=await document.embedFont(fs.readFileSync('public/assets/fonts/NotoSansTC-PDF.ttf'),{subset:false});const width=mm(56);
  for(const name of ['FLUPINE福安源錠0.25MG(管4)','XALATAN舒而坦眼藥水2.5ML(黃盒)','DIPOXIDO大益神膠囊10MG(管4)']){
    const lines=wrapText(name,noto,PRINT.nameSize,width);assert.equal(lines.join(''),name);
    assert.ok(lines.some(l=>l.includes(name.slice(name.lastIndexOf('(')))),lines.join(' | '));
    for(const l of lines)assert.ok(noto.widthOfTextAtSize(l,PRINT.nameSize)<=width,l);
  }
});
test('system-printed report prefixes (exact text layer)',()=>{
  const cases:[string,string][]=[
    ['!避光A-30粒/盒FYNASID菲那諾膜衣錠5MG','FYNASID菲那諾膜衣錠5MG'],
    ['自費B-4粒/盒Silden速立壯膜衣錠100MG','Silden速立壯膜衣錠100MG'],
    ['追追C-140粒/盒TAKEPRON泰克胃通口溶錠30MG','TAKEPRON泰克胃通口溶錠30MG'],
    ['禁請追追禁售C-980粒/盒(14/排)HIROS喜洛緩釋微粒膠囊(複方)','HIROS喜洛緩釋微粒膠囊(複方)'],
    ['C-100瓶/箱ALPHA測試液','ALPHA測試液'],
    ['C-1260包/箱(42包/袋)BETA測試散','BETA測試散'],
    ['避光C-500粒/盒(10粒/排)U-CA活維D軟膠囊0.25MCG','U-CA活維D軟膠囊0.25MCG'],
    ['C-50包/盒U-CITRA優暢粒劑5G','U-CITRA優暢粒劑5G'],
    ['不售C-(停產-不得製造)1000粒/瓶ZINGA鋅寶錠10MG','ZINGA鋅寶錠10MG'],
    ['停供自費避光C-(藥證已註銷)ATANAAL壓達能軟膠囊5MG-改192909','ATANAAL壓達能軟膠囊5MG-改192909'],
    ['停供冷藏C-50瓶/封CHLORAMPHENICOL氯絲菌素眼藥水0.25% 5ML','CHLORAMPHENICOL氯絲菌素眼藥水0.25% 5ML'],
    ['C-10支/捆BENAZON平痔隆軟膏20G(盒)','BENAZON平痔隆軟膏20G(盒)'],
    ['不售C-(停產)840包/盒(3包/聯)ULBAN A胃樂伴顆粒1G','ULBAN A胃樂伴顆粒1G'],
    ['C-980粒/盒(7粒/徘)PANHO盼胃好腸溶膜衣錠40MG','PANHO盼胃好腸溶膜衣錠40MG'],
    ['C-1000粒/盒(10粒//排)FELO費落持續釋放膜衣錠10MG','FELO費落持續釋放膜衣錠10MG'],
    ['公費C-10粒/盒Eraflu易剋冒膠囊75MG','Eraflu易剋冒膠囊75MG'],
    ['限店禁售冷藏追追自費C-1支/盒MOUNJARO猛健樂筆2.5MG/0.6ML-高價藥','MOUNJARO猛健樂筆2.5MG/0.6ML'],
    ['不售-C-DUORIDONE胃利通錠10MG-診所用','DUORIDONE胃利通錠10MG-診所用'],
    ['近效C-&(2027.09)30粒/瓶RITALIN利長能持續性膠囊40MG(管3)','RITALIN利長能持續性膠囊40MG(管3)'],
    ['不售自費C-(藥證已註銷)&100粒/瓶ULTRACET及通安錠(複方)(管4)-高價藥-診所用','ULTRACET及通安錠(複方)(管4)-診所用'],
    ['停供C-(停產)&700粒/盒(7粒/排)ONSLEEP入眠順膠囊10MG(管4)','ONSLEEP入眠順膠囊10MG(管4)'],
  ];
  for(const [raw,expected] of cases){const result=cleanProductName(raw,true);assert.equal(result.name,expected,raw);assert.equal(result.uncertain,false,raw);assert.deepEqual(result.notes,[],raw);}
  // Without a status, A-/B- are not markers.
  assert.equal(cleanProductName('B-COMPLEX 測試錠',true).name,'B-COMPLEX測試錠');
  // Exact text never applies OCR-damage repairs.
  assert.equal(cleanProductName('C-&1000粒/會ABC',true).name,'1000粒/會ABC');
  assert.equal(cleanProductName('公費-Paxlovid療程',true).name,'Paxlovid療程');
  assert.equal(cleanProductName('$-診所[公]費C-10粒/TAMIFLU克流感75公絲',true).uncertain,true);
});
