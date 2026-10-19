import test from 'node:test';import assert from 'node:assert/strict';
import {feedbackKey,feedbackRecord,FEEDBACK_FORMAT,sendFeedback,worthSending} from '../src/management-feedback';
import type {StockRow,UsageRow} from '../src/management-model';
const origin={file:0,filePage:1,reportPage:1,top:0,bottom:0};
const use=(id:string,extra:Partial<UsageRow>={}):UsageRow=>({id,origin,sku:'000001',rawName:'C-測試錠',unit:'粒',count:'10',quantity:'100',notes:[],reviewed:true,...extra});
const stock=(id:string,extra:Partial<StockRow>={}):StockRow=>({id,origin,sku:'000002',rawName:'冷藏 C-測試筆',name:'冷藏 測試筆',location:'A1',qty:'40',notes:[],reviewed:true,...extra});
const run=(before:(UsageRow|StockRow)[],after:{usage:UsageRow[];stock:StockRow[]})=>feedbackRecord({originals:new Map(before.map(r=>[r.id,{...r}])),usageRows:after.usage,stockRows:after.stock,
  safetyStrategy:'balanced',partnerClinic:true,partnerCover:'wide',app:'1.1.3',sent:'2026-10-19T00:00:00Z',store:26});

test('the review record keeps name corrections, structural edits, false alarms and user exclusions',()=>{
  const before=[stock('s1',{notes:['前綴含未知狀態文字「些售」，已移除，請確認'],reviewed:false,name:'些售 測試筆'}),stock('s2',{reviewed:false,notes:['包裝規格疑似誤辨']}),stock('s3'),
    use('u1',{unit:'',reviewed:false}),use('u2'),use('u3',{sku:'R001',excluded:'非六碼編號「R001」，不列入品項數 N'})];
  const record=run(before,{
    stock:[stock('s1',{name:'冷藏 測試筆',notes:before[0].notes,reviewed:true}),stock('s2',{reviewed:true,notes:['包裝規格疑似誤辨']}),stock('s3',{excluded:'使用者排除：重複匯入'})],
    usage:[use('u1',{unit:'支',reviewed:true}),use('u2'),use('u3',{sku:'R001',excluded:'非六碼編號「R001」，不列入品項數 N'})]});
  assert.equal(record.format,FEEDBACK_FORMAT);assert.equal(record.version,2);assert.equal(record.store,26);
  assert.deepEqual(record.options,{safetyStrategy:'balanced',partnerClinic:true,partnerCover:'wide'});
  assert.deepEqual(record.names,[{sku:'000002',rawName:'冷藏 C-測試筆',cleaned:'些售 測試筆',corrected:'冷藏 測試筆',notes:['前綴含未知狀態文字「些售」，已移除，請確認']}]);
  assert.deepEqual(record.edits,[{report:'usage',sku:'000001',rawName:'C-測試錠',field:'unit',before:'',after:'支'}]);
  assert.deepEqual(record.confirmedAsIs,[{report:'inventory',sku:'000002',rawName:'冷藏 C-測試筆',name:'冷藏 測試筆',notes:['包裝規格疑似誤辨']}],'only a flagged row confirmed unchanged; an unflagged row is not a false alarm');
  assert.deepEqual(record.exclusions,[{report:'inventory',sku:'000002',rawName:'冷藏 C-測試筆',reason:'重複匯入'}]);
  assert.deepEqual(record.summary,{usageRows:3,stockRows:3,flagged:3,edited:2,confirmedAsIs:1,userExcluded:1,autoExcluded:1});
});
test('changed figures are recorded by field name only, never their values',()=>{
  const record=run([use('u1'),stock('s1')],{usage:[use('u1',{count:'12',quantity:'130'})],stock:[stock('s1',{qty:'-2'})]});
  assert.deepEqual(record.edits.map(e=>e.field).sort(),['count','qty','quantity']);
  for(const edit of record.edits){assert.equal('before' in edit,false);assert.equal('after' in edit,false);}
  const text=JSON.stringify(record);for(const figure of ['"12"','"130"','"-2"','"40"','"100"'])assert.ok(!text.includes(figure),figure);
});
test('a corrected code is reported under the code as parsed',()=>{
  const record=run([use('u1',{sku:'00001',reviewed:false})],{usage:[use('u1',{sku:'000001',reviewed:true})],stock:[]});
  assert.deepEqual(record.edits,[{report:'usage',sku:'00001',rawName:'C-測試錠',field:'sku',before:'00001',after:'000001'}]);
  assert.equal(record.confirmedAsIs.length,0,'an edited row is not a false alarm');
});
test('only a review with something to learn from is sent, once per distinct review',()=>{
  const plain=run([use('u1'),stock('s1')],{usage:[use('u1')],stock:[stock('s1')]});
  assert.equal(worthSending(plain),false,'nothing corrected, confirmed after a warning or excluded');
  const edited=run([stock('s1')],{usage:[],stock:[stock('s1',{name:'冷藏 測試注射筆'})]});
  assert.equal(worthSending(edited),true);
  assert.equal(feedbackKey({...edited,sent:'later'}),feedbackKey(edited),'generating again later is the same review');
  assert.notEqual(feedbackKey(run([stock('s1')],{usage:[],stock:[stock('s1',{name:'冷藏 另一個名稱'})]})),feedbackKey(edited));
  const unknown=feedbackRecord({originals:new Map(),usageRows:[],stockRows:[],safetyStrategy:'hamster',partnerClinic:false,partnerCover:'standard',app:'x',sent:'t',store:Number.NaN});
  assert.equal('store' in unknown,false,'an unreadable store number is left out');
});
test('the record is posted as a simple text/plain request the Apps Script can take without a preflight',async()=>{
  const record=run([stock('s1')],{usage:[],stock:[stock('s1',{name:'冷藏 測試注射筆'})]});const calls:[string,RequestInit][]=[];
  await sendFeedback(record,'https://script.example/exec',(async(url:string,init:RequestInit)=>{calls.push([url,init]);return new Response();}) as typeof fetch);
  assert.equal(calls.length,1);const [url,init]=calls[0];
  assert.equal(url,'https://script.example/exec');assert.equal(init.method,'POST');assert.equal(init.mode,'no-cors');
  assert.deepEqual(init.headers,{'Content-Type':'text/plain;charset=utf-8'});assert.deepEqual(JSON.parse(init.body as string),record);
});
