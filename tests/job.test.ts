import test from 'node:test';import assert from 'node:assert/strict';import {InventoryJob} from '../src/job';
const page=(n:number)=>({report:{page:n,width:1,height:1,rotation:0,deskew:0,status:'accepted' as const,reason:'',rowCount:0,skippedZero:0,storeName:''},rows:[]});
test('200 pages run sequentially with pause, resume and bounded active images',async()=>{
  let active=0,peak=0,calls=0;let job:InventoryJob;let paused=false;const states:string[]=[];
  const engine={layout:{},initialize:async()=>{},extract:async(_source:unknown,n:number)=>{active++;peak=Math.max(peak,active);calls++;await new Promise(resolve=>setTimeout(resolve,1));active--;return page(n);},terminate:async()=>{}};
  job=new InventoryJob(engine as any,{pages:200} as any,{state:s=>{states.push(s);if(s==='paused'){paused=true;job.resume();}},page:r=>{if(r.page===3)job.pause();},error:message=>assert.fail(message)});
  await job.run();assert.equal(calls,200);assert.equal(peak,1);assert.equal(paused,true);assert.equal(job.state,'complete');assert.ok(states.includes('paused'));
});
test('cancel stops later pages and incomplete jobs cannot finish',async()=>{
  let calls=0;let job:InventoryJob;const engine={layout:{},initialize:async()=>{},extract:async(_s:unknown,n:number)=>{calls++;return page(n);},terminate:async()=>{}};
  job=new InventoryJob(engine as any,{pages:200} as any,{state:()=>{},page:r=>{if(r.page===2)void job.cancel();},error:m=>assert.fail(m)});
  await job.run();assert.equal(calls,2);assert.equal(job.state,'cancelled');assert.equal(job.running,false);
});
test('cancel returns even when the OCR worker never answers',async()=>{
  let job:InventoryJob;const engine={layout:{},initialize:async()=>{},extract:()=>new Promise(()=>{}),terminate:async()=>{}};
  job=new InventoryJob(engine as any,{pages:3} as any,{state:()=>{},page:()=>{},error:m=>assert.fail(m)});
  const running=job.run();setTimeout(()=>void job.cancel(),5);await running;assert.equal(job.state,'cancelled');assert.equal(job.running,false);
});
