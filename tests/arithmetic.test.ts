import assert from 'node:assert/strict';
import { addDays, autoCalculate, rangeDays, calculate, dayNumber, dial, inferVisit, rocDate, sameOutcome, taiwanToday, visitAfter } from '../src/arithmetic-model';
import { decodePrescriptionBytes, parsePrescription, parsePrescriptionBytes, parsePrescriptionDrugs, parsePrescriptionSlip } from '../src/prescription-qr';

assert.equal(taiwanToday(new Date('2026-10-23T16:00:00Z')), '2026-10-24');
assert.equal(taiwanToday(new Date('2026-10-23T15:59:59Z')), '2026-10-23');
assert.equal(addDays('2026-10-24', 20), '2026-11-13');
assert.equal(addDays('2026-12-20', 20), '2027-01-09');
assert.equal(addDays('2028-02-20', 20), '2028-03-11');
assert.throws(() => dayNumber('2026-02-29'));
assert.equal(rocDate('0990101'), '2010-01-01');
assert.throws(() => rocDate('1150230'));
const input = { date: '2026-01-01', days: 30, count: 3, visit: 1 };
let result = calculate(input, '2026-01-01');
assert.deepEqual(result.next, { start: '2026-01-21', end: '2026-01-30' });
assert.equal(result.expiry, '2026-04-01');
assert.equal(result.earliestReturn, '2026-03-22');
assert.deepEqual(result.schedule[2], { start: '2026-02-20', end: '2026-03-01' });
for (const days of [28, 29, 30]) {
  const value = calculate({ ...input, days }, '2026-01-01');
  assert.equal(value.schedule[1].start, addDays(input.date, days - 10));
  assert.equal(value.expiry, addDays(input.date, days * 3));
}
assert.equal(calculate({ ...input, visit: 2 }, '2026-01-20').state, 'early');
assert.equal(calculate({ ...input, visit: 2 }, '2026-01-21').state, 'normal');
assert.equal(calculate({ ...input, visit: 2 }, '2026-01-30').state, 'normal');
result = calculate({ ...input, visit: 2 }, '2026-02-05');
assert.equal(result.state, 'late');
assert.deepEqual(result.next, { start: '2026-02-25', end: '2026-03-06' });
assert.equal(calculate({ ...input, visit: 3 }, '2026-03-01').returnDate, '2026-03-22');
assert.deepEqual(calculate({ ...input, visit: 2 }, '2026-03-10').next, { start: '2026-03-30', end: '2026-04-01' });
assert.equal(calculate({ ...input, visit: 3 }, '2026-03-12').returnDate, '2026-04-01');
assert.equal(calculate(input, '2026-04-01').state, 'late'); // Source sheet includes expiry day.
assert.equal(calculate(input, '2026-04-02').state, 'invalid');
assert.equal(calculate(input, '2026-04-02').message, '處方已於115/04/01失效，請回診。');
assert.equal(calculate({ date: '2026-08-19', days: 28, count: 2, visit: 2 }, '2026-10-24').message, '處方已於115/10/14失效，請回診。');
assert.equal(calculate(input, '2025-12-31').state, 'invalid');
assert.equal(calculate({ ...input, count: 2, visit: 3 }, '2026-01-01').state, 'invalid');

// Synthetic placeholders only. Empty fixed fields and decimal strings are intentional.
const fields = ['0000000000', '2', '', '測試', '', '0990101', '', '1150101', '', '28', '', 'A#B', '', '  ', 'TESTCODE01', '.5', 'QD AM', 'PO', '14'];
const sample = fields.join(';') + ';';
assert.deepEqual(parsePrescription(sample), { date: '2026-01-01', days: 28, drugCount: 1, encoding: '文字輸入' });
assert.equal(parsePrescription('\uFEFF' + sample).drugCount, 1);
assert.equal(parsePrescriptionBytes(new TextEncoder().encode(sample)).encoding, 'utf-8');
// Big5 bytes A4 A4 encode 中. Patient name is never returned.
const prefix = new TextEncoder().encode(fields.slice(0, 3).join(';') + ';');
const suffix = new TextEncoder().encode(';' + fields.slice(4).join(';') + ';');
const big5 = new Uint8Array([...prefix, 0xA4, 0xA4, ...suffix]);
assert.equal(decodePrescriptionBytes(big5).encoding, 'big5');
assert.equal(parsePrescriptionBytes(big5).date, '2026-01-01');
assert.throws(() => decodePrescriptionBytes(new Uint8Array([0x81])));
assert.throws(() => parsePrescription(sample + ';'));
assert.throws(() => parsePrescription(fields.slice(0, 18).join(';') + ';'));
assert.throws(() => parsePrescription(sample.replace('1150101', '1150230')));
assert.throws(() => parsePrescription(sample.replace(';2;', ';1;')));
assert.throws(() => parsePrescription(sample.replace('測試', '\uFFFD')));
assert.throws(() => parsePrescription(sample.replace(';PO;', ';;')));
assert.throws(() => parsePrescription(sample.replace(';14;', ';0;')));
assert.throws(() => parsePrescription(sample.replace(';14;', ';X1;')));
// The dose is not read and its format varies by hospital; only a blank one is rejected.
assert.equal(parsePrescription(sample.replace(';.5;', ';X1;')).drugCount, 1);
assert.throws(() => parsePrescription(sample.replace(';.5;', '; ;')));
assert.throws(() => parsePrescription(sample.replace(';28;', ';90;')));
// The slip parser keeps who and where; the date parser above still returns no identifying field.
const slipFields = [...fields];
slipFields[2] = '04';
slipFields[4] = 'a123456789';
let slipQR = parsePrescriptionSlip(slipFields.join(';') + ';');
// rx is what the prescription check reads: diagnoses, 就醫科別, the age band on the visit date, each drug's frequency and route.
assert.deepEqual(slipQR, { date: '2026-01-01', days: 28, drugCount: 1, encoding: '文字輸入', institution: '0000000000', name: '測試', idNumber: 'A123456789', birth: '2010-01-01', drugs: [{ code: 'TESTCODE01', total: '14' }],
  rx: { dx: ['A', 'B'], dept: '', age: 'AGE10-19', drugs: [{ code: 'TESTCODE01', frequency: 'QD AM', route: 'PO' }] } });
slipFields[4] = '12345';
slipFields[5] = '';
slipQR = parsePrescriptionSlip(slipFields.join(';') + ';');
assert.deepEqual([slipQR.idNumber, slipQR.birth], ['', '']);
assert.throws(() => parsePrescriptionSlip(sample.replace(';PO;', ';;')));
// Layout of a real eye clinic QR, patient fields replaced: dose X1 for drops and ointment, notes joined by commas in field 14.
const eye = [...slipFields.slice(0, 13), '3,00000000,過敏史:無,TESTVISITID', 'TESTCODE01', 'X1', 'QID', 'OS', '1', 'TESTCODE02', 'X1', 'QN', 'OU', '1'];
assert.deepEqual(parsePrescriptionSlip(eye.join(';') + ';').drugs, [{ code: 'TESTCODE01', total: '1' }, { code: 'TESTCODE02', total: '1' }]);
// A scanner that types each Big5 or UTF-8 byte as a Windows-1252 character (測試 → ´ú¸Õ) is decoded back.
const byteTyped = (bytes: Uint8Array) => [...bytes].map(byte => new TextDecoder('windows-1252').decode(Uint8Array.of(byte))).join('');
const big5Fields = [...slipFields];
big5Fields[3] = byteTyped(Uint8Array.of(0xb4, 0xfa, 0xb8, 0xd5));
assert.equal(big5Fields[3], '´ú¸Õ');
slipQR = parsePrescriptionSlip(big5Fields.join(';') + ';');
assert.deepEqual([slipQR.name, slipQR.encoding], ['測試', '逐位元組還原 big5']);
big5Fields[3] = byteTyped(new TextEncoder().encode('測試'));
assert.deepEqual([parsePrescriptionSlip(big5Fields.join(';') + ';').name, parsePrescription(big5Fields.join(';') + ';').date], ['測試', '2026-01-01']);
// Text that cannot be read back as bytes stays as scanned.
big5Fields[3] = 'Zoë';
assert.equal(parsePrescriptionSlip(big5Fields.join(';') + ';').name, 'Zoë');
// A prescription with many drugs has a second QR of drug fields only, with nothing in the first saying it follows.
assert.deepEqual(parsePrescriptionDrugs('TESTCODE02;1;qd;po;30;TESTCODE03;1;QD;PO;30;'), { drugs: [{ code: 'TESTCODE02', total: '30' }, { code: 'TESTCODE03', total: '30' }],
  rx: [{ code: 'TESTCODE02', frequency: 'QD', route: 'PO' }, { code: 'TESTCODE03', frequency: 'QD', route: 'PO' }], encoding: '文字輸入' });
assert.equal(parsePrescriptionDrugs('\uFEFFTESTCODE02;1;QD;PO;30;')?.drugs.length, 1);
for (const other of [sample, slipFields.join(';') + ';', 'TESTCODE02;1;QD;PO;', '4710000000000']) assert.equal(parsePrescriptionDrugs(other), undefined);
assert.throws(() => parsePrescriptionDrugs('TESTCODE02;1;QD;;30;'));
assert.throws(() => parsePrescriptionDrugs('TESTCODE02;1;QD;PO;0;'));
for (const size of [1, 2, 3, 5]) {
  const text = [...fields.slice(0, 14), ...Array.from({ length: size }, () => fields.slice(14)).flat()].join(';') + ';';
  assert.equal(parsePrescription(text).drugCount, size);
}
console.log('arithmetic date boundaries, Taiwan rollover, and prescription QR contract passed');

// QR codes omit refill count and visit number; infer them from today.
const auto = (today: string, extra: { count?: number; visit?: number } = {}) => autoCalculate({ date: '2026-01-01', days: 30, ...extra }, today);
let scenarios = auto('2026-01-01');
assert.deepEqual(scenarios.map(s => s.visit), [1, 1]);
assert.ok(sameOutcome(scenarios[0], scenarios[1]));
assert.deepEqual(scenarios[1].result.next, { start: '2026-01-21', end: '2026-01-30' });
scenarios = auto('2026-01-25'); // Visit 2 window: count decides next refill vs return.
assert.deepEqual(scenarios.map(s => [s.count, s.visit, s.result.state]), [[2, 2, 'normal'], [3, 2, 'normal']]);
assert.equal(scenarios[0].result.returnDate, '2026-02-20');
assert.deepEqual(scenarios[1].result.next, { start: '2026-02-20', end: '2026-03-01' });
assert.ok(!sameOutcome(scenarios[0], scenarios[1]));
scenarios = auto('2026-01-03'); // Before visit 2 opens: handed in early for pre-processing.
assert.deepEqual(scenarios.map(s => [s.visit, s.result.state]), [[2, 'early'], [2, 'early']]);
assert.match(scenarios[0].note!, /提前交付處方預處理/);
assert.deepEqual(scenarios[0].result.schedule[1], { start: '2026-01-21', end: '2026-01-30' });
scenarios = auto('2026-02-05'); // After visit 2: count 2 is late, count 3 is early for visit 3.
assert.deepEqual(scenarios.map(s => [s.visit, s.result.state]), [[2, 'late'], [3, 'early']]);
scenarios = auto('2026-02-25'); // Visit 3 window only exists for count 3.
assert.deepEqual(scenarios.map(s => [s.visit, s.result.state]), [[2, 'late'], [3, 'normal']]);
assert.equal(scenarios[1].result.returnDate, '2026-03-22');
scenarios = auto('2026-03-10');
assert.equal(scenarios[0].result.state, 'invalid'); // Count 2 expired on 2026-03-02.
assert.equal(scenarios[1].visit, 3);
assert.deepEqual(auto('2026-01-25', { count: 3 }).map(s => s.visit), [2]);
assert.deepEqual(auto('2026-01-25', { visit: 3 }).map(s => s.count), [3]);
assert.equal(auto('2026-01-25', { count: 2, visit: 3 })[0].result.state, 'invalid');
assert.ok(auto('2025-12-31').every(s => s.result.state === 'invalid'));
assert.equal(inferVisit('2026-01-01', 28, 3, '2026-01-31').visit, 3); // Early visit 3 for 28-day prescriptions.
assert.equal(inferVisit('2026-01-01', 28, 2, '2026-01-31').visit, 2); // No visit 3: late visit 2.
// Late visit 2 clamped by expiry: only 5 days remain (2026-11-11 ~ 2026-11-15).
const clamped = calculate({ date: '2026-08-23', days: 28, count: 3, visit: 2 }, '2026-10-24').next!;
assert.deepEqual(clamped, { start: '2026-11-11', end: '2026-11-15' });
assert.equal(rangeDays(clamped), 5);
assert.equal(rangeDays(calculate(input, '2026-01-01').next!), 10);
// A late pickup restarts every visit after it from today: late visit 1 on 10/31 moves visit 2 and visit 3, which expiry cuts to 5 days.
result = calculate({ date: '2026-09-27', days: 28, count: 3, visit: 1 }, '2026-10-31');
assert.deepEqual([result.state, result.next, result.later], ['late', { start: '2026-11-18', end: '2026-11-27' }, [{ start: '2026-12-16', end: '2026-12-20' }]]);
assert.deepEqual(calculate({ date: '2026-09-27', days: 28, count: 2, visit: 1 }, '2026-10-31').later, []);
assert.deepEqual(calculate({ ...input, visit: 2 }, '2026-02-05').later, []);
// Too late for visit 3 to start before expiry: only visit 2 is left.
result = calculate({ date: '2026-09-27', days: 28, count: 3, visit: 1 }, '2026-11-05');
assert.deepEqual([result.next, result.later], [{ start: '2026-11-23', end: '2026-12-02' }, []]);
const pair = autoCalculate({ date: '2026-09-27', days: 28, visit: 1 }, '2026-10-31');
assert.ok(!sameOutcome(pair[0], pair[1]));
console.log('arithmetic visit inference passed');

// A late previous pickup restarts its period: visit 3 moves from 2/20～3/1 to 2/25～3/6 after visit 2 on 2/5.
const third = { ...input, visit: 3, previous: '2026-02-05' };
assert.equal(calculate({ ...input, visit: 3 }, '2026-02-22').state, 'normal'); // The case this field exists for.
result = calculate(third, '2026-02-22');
assert.equal(result.state, 'early');
assert.deepEqual(result.schedule[2], { start: '2026-02-25', end: '2026-03-06' });
assert.equal(result.earliestReturn, '2026-03-27');
assert.deepEqual(result.shift, { previous: '2026-02-05', original: calculate(input, '2026-01-01').schedule, originalReturn: '2026-03-22' });
assert.equal(calculate({ ...input, visit: 3 }, '2026-03-03').state, 'late');
result = calculate(third, '2026-03-03');
assert.deepEqual([result.state, result.message, result.returnDate], ['normal', '本次在順延後的領藥區間內，可領藥。', '2026-03-27']);
result = calculate(third, '2026-03-08'); // Late again: corrected from today as before.
assert.deepEqual([result.state, result.next], ['late', { start: '2026-03-28', end: '2026-04-01' }]);
// A pickup inside its window, or on the day its period would start anyway, moves nothing.
for (const previous of ['2026-01-21', '2026-01-25', '2026-01-30', '2026-01-31']) {
  assert.deepEqual(calculate({ ...third, previous }, '2026-02-22'), calculate({ ...input, visit: 3 }, '2026-02-22'));
}
// Visit 1 two days late moves visit 2 and visit 3.
result = calculate({ ...input, visit: 2, previous: '2026-01-03' }, '2026-01-21');
assert.equal(result.state, 'early');
assert.deepEqual(result.schedule.slice(1), [{ start: '2026-01-23', end: '2026-02-01' }, { start: '2026-02-22', end: '2026-03-03' }]);
assert.deepEqual([result.next, result.earliestReturn], [undefined, '2026-03-24']);
assert.deepEqual(calculate({ ...input, visit: 2, previous: '2026-01-03' }, '2026-01-25').next, { start: '2026-02-22', end: '2026-03-03' });
// Expiry cuts a moved window short, or removes it.
const short = { date: '2026-08-23', days: 28, count: 3, visit: 3 };
result = calculate({ ...short, previous: '2026-10-24' }, '2026-11-05');
assert.deepEqual([result.state, result.schedule[2], result.earliestReturn], ['early', { start: '2026-11-11', end: '2026-11-15' }, '2026-12-09']);
result = calculate({ ...short, previous: '2026-10-30' }, '2026-11-05');
assert.deepEqual([result.state, result.schedule.length, result.returnDate], ['invalid', 2, '2026-11-17']);
assert.equal(result.message, '前次逾期領藥後已無第 3 次，請回診，建議最早115/11/17。');
// Previous dates that cannot be right.
assert.equal(calculate({ ...input, previous: '2026-01-01' }, '2026-01-21').message, '第 1 次領藥沒有前次，請清除前次領藥日。');
assert.equal(calculate(third, '2026-02-04').message, '前次領藥日不能晚於今天。');
assert.equal(calculate({ ...third, previous: '2026-01-15' }, '2026-02-22').message, '前次領藥日早於第 2 次可領藥區間（115/01/21 起），請核對日期或本次次數。');
assert.match(calculate({ ...input, visit: 2, previous: '2025-12-31' }, '2026-01-21').message, /早於第 1 次可領藥區間/);
assert.throws(() => calculate({ ...third, previous: '2026-02-30' }, '2026-02-22'));
// Same windows as the late correction made on the day of the previous pickup, for every late day.
for (const days of [28, 29, 30]) {
  const base = { date: '2026-01-01', days, count: 3 };
  for (const visit of [2, 3]) {
    const prior = calculate({ ...base, visit: 1 }, '2026-01-01').schedule[visit - 2];
    for (let previous = addDays(prior.end, 1); previous <= addDays(base.date, days * 3); previous = addDays(previous, 1)) {
      const late = calculate({ ...base, visit: visit - 1 }, previous);
      const moved = calculate({ ...base, visit, previous }, previous);
      if (late.next) assert.deepEqual(moved.schedule[visit - 1], late.next, `${days} 天第 ${visit} 次 前次 ${previous}`);
      else assert.deepEqual([moved.state, moved.returnDate], ['invalid', late.returnDate], `${days} 天第 ${visit} 次 前次 ${previous}`);
    }
  }
}
// A blank visit follows the previous pickup instead of today.
assert.deepEqual([visitAfter('2026-01-01', 30, 3, '2026-01-03'), visitAfter('2026-01-01', 30, 3, '2026-01-21'), visitAfter('2026-01-01', 30, 3, '2026-02-05')], [2, 3, 3]);
assert.equal(visitAfter('2026-01-01', 30, 3, '2026-02-20'), 4);
scenarios = autoCalculate({ date: '2026-01-01', days: 30, previous: '2026-02-05' }, '2026-02-22');
assert.deepEqual(scenarios.map(s => [s.count, s.visit, s.inferred, s.result.state]), [[2, 3, true, 'invalid'], [3, 3, true, 'early']]);
assert.deepEqual([scenarios[0].result.message, scenarios[0].result.returnDate], ['前次已是最後一次（第 2 次）領藥，請回診，建議最早115/02/25。', '2026-02-25']);
assert.equal(autoCalculate({ date: '2026-01-01', days: 30, count: 2, visit: 3, previous: '2026-02-05' }, '2026-02-22')[0].result.message, '本次領藥次數超過處方可調劑次數。');
// Each count's expiry cuts the same moved window differently, so the two are not merged.
scenarios = autoCalculate({ date: '2026-01-01', days: 30, visit: 2, previous: '2026-02-05' }, '2026-02-22');
assert.deepEqual(scenarios.map(s => s.result.schedule[1]), [{ start: '2026-02-25', end: '2026-03-02' }, { start: '2026-02-25', end: '2026-03-06' }]);
assert.ok(!sameOutcome(scenarios[0], scenarios[1]));
console.log('arithmetic previous-pickup shift passed');

// The dial: today picks up one of the visits whose window has opened, or none (that one was picked up elsewhere) and books the next.
const order = (d: ReturnType<typeof dial>) => d.slots.map((s, i) => { const name = s.kind === 'idle' ? 'idle' : i + 1; return i === d.start ? `*${name}` : name; });
const idleRow = (d: ReturnType<typeof dial>, count?: number) => d.slots.at(-1)!.rows.find(r => !count || r.count === count)!;
let wheel = dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-01-25'); // Inside visit 2's window.
assert.deepEqual(order(wheel), [1, '*2', 'idle']);
assert.deepEqual(wheel.slots.map(s => s.rows[0].result.state), ['late', 'normal', 'early']);
assert.deepEqual([idleRow(wheel).visit, idleRow(wheel).result.schedule[2]], [3, { start: '2026-02-20', end: '2026-03-01' }]);
wheel = dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-02-05'); // Past visit 2's window: visit 2 was picked up elsewhere.
assert.deepEqual(order(wheel), [1, 2, '*idle']);
assert.equal(wheel.slots[1].rows[0].result.state, 'late');
wheel = dial({ date: '2026-01-01', days: 30 }, '2026-02-05'); // Count 2 would stay on a late visit 2, count 3 on idle: the later wins.
assert.deepEqual(order(wheel), [1, 2, '*idle']);
assert.deepEqual(wheel.slots[1].rows.map(r => [r.count, r.inferred]), [[2, true], [3, false]]);
assert.deepEqual(wheel.slots[2].rows.map(r => [r.count, r.visit, r.inferred, r.result.state]), [[2, 3, false, 'invalid'], [3, 3, true, 'early']]);
assert.deepEqual([idleRow(wheel, 2).result.message, idleRow(wheel, 2).result.returnDate], ['第 2 次（最後一次）已領，請回診，建議最早115/02/20。', '2026-02-20']);
wheel = dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-01-03'); // Before visit 2 opens: book visit 2.
assert.deepEqual(order(wheel), [1, '*idle']);
assert.deepEqual([idleRow(wheel).visit, idleRow(wheel).result.state], [2, 'early']);
assert.deepEqual(order(dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-01-01')), ['*1', 'idle']);
wheel = dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-02-25'); // Inside the last window; not picking up means it is done.
assert.deepEqual(order(wheel), [1, 2, '*3', 'idle']);
assert.equal(idleRow(wheel).result.returnDate, '2026-03-22');
assert.deepEqual(order(dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-03-03')), [1, 2, '*3', 'idle']); // Past the last window: a late pickup.
wheel = dial({ date: '2026-01-01', days: 30 }, '2026-02-25'); // Visit 3 only exists for count 3.
assert.deepEqual(wheel.slots.map(s => s.rows.map(r => r.count)), [[2, 3], [2, 3], [3], [2, 3]]);
assert.equal(wheel.start, 2);
// A late previous pickup moves only the idle slot.
wheel = dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-02-12', { idle: '2026-02-05' });
assert.deepEqual([idleRow(wheel).result.state, idleRow(wheel).result.schedule[2], idleRow(wheel).result.shift?.previous], ['early', { start: '2026-02-25', end: '2026-03-06' }, '2026-02-05']);
assert.equal(wheel.slots[1].rows[0].result.shift, undefined);
assert.match(idleRow(dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-02-12', { idle: '2026-01-15' })).result.message, /前次領藥日早於第 2 次可領藥區間/);
assert.match(idleRow(dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-03-05', { idle: '2026-03-03' })).result.message, /前次已是最後一次（第 3 次）領藥，請回診，建議最早115\/03\/23/);
// Each pickup slot from visit 2 has its own previous date: a late visit 2 moves today's visit 3 into pre-processing.
assert.equal(dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-02-22').slots[2].rows[0].result.state, 'normal');
wheel = dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-02-22', { 3: '2026-02-05' });
assert.deepEqual(order(wheel), [1, 2, '*3', 'idle']);
assert.deepEqual([wheel.slots[2].rows[0].result.state, wheel.slots[2].rows[0].result.schedule[2]], ['early', { start: '2026-02-25', end: '2026-03-06' }]);
assert.deepEqual([wheel.slots[1].rows[0].result.shift, idleRow(wheel).result.shift, idleRow(wheel).result.returnDate], [undefined, undefined, '2026-03-22']);
wheel = dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-01-25', { 2: '2026-01-03' }); // A late visit 1 moves only today's visit 2.
assert.deepEqual([wheel.slots[1].rows[0].result.state, wheel.slots[1].rows[0].result.schedule[1], idleRow(wheel).result.shift], ['normal', { start: '2026-01-23', end: '2026-02-01' }, undefined]);
assert.match(dial({ date: '2026-01-01', days: 30, count: 3 }, '2026-02-22', { 3: '2026-01-15' }).slots[2].rows[0].result.message, /前次領藥日早於第 2 次可領藥區間/);
// Expired, or not yet valid: nothing to turn.
wheel = dial({ date: '2026-01-01', days: 30 }, '2026-03-10');
assert.deepEqual(wheel.dead.map(s => [s.count, s.result.message]), [[2, '處方已於115/03/02失效，請回診。']]);
assert.ok(wheel.slots.every(s => s.rows.every(r => r.count === 3)));
assert.deepEqual([dial({ date: '2026-01-01', days: 30 }, '2025-12-31').slots, dial({ date: '2026-01-01', days: 30 }, '2025-12-31').dead.length], [[], 2]);
console.log('arithmetic dial passed');
