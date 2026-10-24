import assert from 'node:assert/strict';
import { addDays, calculate, dayNumber, rocDate, taiwanToday } from '../src/arithmetic-model';
import { decodePrescriptionBytes, parsePrescription, parsePrescriptionBytes } from '../src/prescription-qr';

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
assert.throws(() => parsePrescription(sample.replace(';.5;', ';0;')));
assert.throws(() => parsePrescription(sample.replace(';28;', ';90;')));
for (const size of [1, 2, 3, 5]) {
  const text = [...fields.slice(0, 14), ...Array.from({ length: size }, () => fields.slice(14)).flat()].join(';') + ';';
  assert.equal(parsePrescription(text).drugCount, size);
}
console.log('arithmetic date boundaries, Taiwan rollover, and prescription QR contract passed');
