import test from 'node:test';import assert from 'node:assert/strict';import {decide} from '../src/vote';
test('a clear majority is accepted without review',()=>{
  assert.deepEqual(decide(['000343','000348','000343','000343','000343'],3),{value:'000343',agreed:true,support:4,candidates:['000343','000348']});
  // Unreadable or wrongly formatted readings (null) do not count against the majority.
  assert.equal(decide([null,'2398','2398','2398',null],3).agreed,true);
});
test('a split or weak vote keeps the best guess but asks for review with candidates',()=>{
  const split=decide(['893','593','893','593','393'],3);assert.equal(split.agreed,false);assert.deepEqual(split.candidates.sort(),['393','593','893']);
  assert.equal(decide(['77','71','77',null,null],3).agreed,false,'two votes are not enough');
  assert.equal(decide([null,null,null],3).value,undefined);
});
