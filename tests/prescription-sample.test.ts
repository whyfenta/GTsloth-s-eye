import assert from 'node:assert/strict';
import { parsePrescription, parsePrescriptionLayout, splitFields } from '../src/prescription-qr';
import { SampleLog, ageBand, deidentify, failureLine, scanKey } from '../src/prescription-sample';

// Synthetic placeholders only, never a real prescription. Field numbers count from 1, as in the README.
const fields = ['0000000000', '1', '12', '測試', 'A123456789', '0500101', '345', '1150101', '0099', '7', 'Z9', 'TESTDX.1#TESTDX2#', '0000000000',
  '9,TESTNOTE01,過敏史:藥物甲,TESTVISIT02', 'TESTCODE01', '1', 'BID', 'PO', '14', 'TESTCODE02', 'X1', 'QID', 'OS', '1'];
const qr = (changes: Record<number, string> = {}) => fields.map((value, i) => changes[i + 1] ?? value).join(';') + ';';
const field = (text: string, n: number) => splitFields(deidentify(text))[n - 1];
const expected = '0000000000;1;12;;;AGE60-69;345;1150101;;7;Z9;TESTDX.1#TESTDX2#;0000000000;過敏史:藥物甲;TESTCODE01;1;BID;PO;14;TESTCODE02;X1;QID;OS;1;';
assert.equal(deidentify(qr()), expected);
// Nothing moves: the line reads back as the same 14 + 5n layout.
assert.equal(parsePrescriptionLayout(expected).fields.length, fields.length);
assert.equal(deidentify('﻿' + qr()), expected);
// Fields 4, 5 and 9 are cleared whatever they hold.
for (const n of [4, 5, 9]) for (const value of ['', '1', 'TESTVALUE', '測驗']) assert.equal(field(qr({ [n]: value }), n), '', `第 ${n} 欄 ${value}`);
// Fields 3, 7 and 11 keep up to 4 letters or digits.
for (const [value, kept] of [['', ''], ['1', '1'], ['AB12', 'AB12'], ['ab9', 'ab9'], ['ABCDE', ''], ['12345', ''], ['12-3', ''], [' 12', ''], ['測', ''], ['１２', '']]) {
  for (const n of [3, 7, 11]) assert.equal(field(qr({ [n]: value }), n), kept, `第 ${n} 欄 ${value}`);
}
// Field 13 is kept only when it repeats field 1.
assert.equal(field(qr({ 1: '1111111111', 13: '1111111111' }), 13), '1111111111');
assert.equal(field(qr({ 13: '1111111111' }), 13), '');
assert.equal(field(qr({ 13: 'TESTVALUE' }), 13), '');
assert.equal(field(qr({ 13: '' }), 13), '');
// Field 14 keeps the allergy history only; a half-width comma inside it ends it.
for (const [value, kept] of [['過敏史:藥物甲', '過敏史:藥物甲'], ['TESTNOTE01,過敏史：無', '過敏史：無'], ['9,TESTNOTE01,TESTVISIT02', ''], ['', ''],
  ['TESTNOTE01,過敏史:藥物甲,藥物乙,TESTVISIT02', '過敏史:藥物甲'], ['TESTNOTE01,過敏史:藥物甲、藥物乙', '過敏史:藥物甲、藥物乙'], ['TEST過敏史:藥物甲', '']]) {
  assert.equal(field(qr({ 14: value }), 14), kept, value);
}
// Drug fields stay as scanned; only a blank one is refused.
assert.equal(field(qr({ 16: '.5', 19: 'X1' }), 19), 'X1');
console.log('prescription sample field rules passed');

// Field 6: completed years on the visit date, 10 years a band.
const visit = '1150101'; // 2026-01-01
for (const [birth, band] of [['1150101', 'AGE0-9'], ['1050102', 'AGE0-9'], ['1050101', 'AGE10-19'], ['0950102', 'AGE10-19'], ['0950101', 'AGE20-29'],
  ['0250102', 'AGE80-89'], ['0250101', 'AGE90+'], ['0010101', 'AGE90+'], [' 1050101 ', 'AGE10-19']]) assert.equal(ageBand(birth, visit), band, birth);
// Born on 2016-02-29: still 9 on 2026-02-28, 10 on 2026-03-01.
assert.deepEqual([ageBand('1050229', '1150228'), ageBand('1050229', '1150301')], ['AGE0-9', 'AGE10-19']);
// A birth date that cannot be read, or one after the visit, leaves the field blank.
for (const birth of ['', '1150102', '1051301', '1050230', '501231', '0000101', 'TESTVAL']) assert.equal(ageBand(birth, visit), '', birth);
assert.equal(ageBand('1050101', '1150230'), '');
assert.equal(field(qr({ 6: '501231' }), 6), '');
// An unreadable visit date is kept as scanned; only the age band is blank.
assert.deepEqual([field(qr({ 8: '1150230' }), 6), field(qr({ 8: '1150230' }), 8)], ['', '1150230']);
console.log('prescription sample age bands passed');

// Wider than the 試算: any prescription type and number of days, which parsePrescription still refuses.
for (const changes of [{ 2: '1' }, { 2: '2', 10: '90' }, { 10: '' }, { 1: '' }] as Record<number, string>[]) assert.doesNotThrow(() => deidentify(qr(changes)));
assert.throws(() => parsePrescription(qr()));
assert.equal(parsePrescription(qr({ 2: '2', 10: '28' })).drugCount, 2);
// A scanner that types every byte as one character is read back first.
const byteTyped = (bytes: Uint8Array) => [...bytes].map(byte => new TextDecoder('windows-1252').decode(Uint8Array.of(byte))).join('');
assert.equal(deidentify(byteTyped(new TextEncoder().encode(qr()))), expected);
// A rejected scan is one line of reason and field count, never its text.
function rejected(text: string): string {
  try { deidentify(text); } catch (error) { return failureLine(text, error); }
  assert.fail('應該無法解析');
}
const short = fields.slice(0, 18).join(';') + ';';
assert.equal(rejected(short), '失敗：不是支援的處方 QR 格式，或藥品欄位不完整，欄位數 18');
assert.equal(rejected(fields.slice(0, 14).join(';') + ';'), '失敗：不是支援的處方 QR 格式，或藥品欄位不完整，欄位數 14');
assert.equal(rejected(qr({ 18: '' })), '失敗：QR 藥品欄位有空白，欄位數 24');
assert.equal(rejected(qr({ 22: ' ' })), '失敗：QR 藥品欄位有空白，欄位數 24');
assert.equal(rejected(qr({ 4: '�' })), '失敗：QR 文字不完整或含亂碼，請重新掃描，欄位數 24');
// Chinese in a kept field means another layout, which could put a name there.
for (const n of [1, 2, 8, 10, 12]) assert.equal(rejected(qr({ [n]: '測試' })), `失敗：第 ${n} 欄出現中文或全形字，可能是不同院所的 QR 格式，欄位數 24`);
assert.equal(failureLine(qr(), 'not an error'), '失敗：無法解析，欄位數 24');
for (const text of [short, qr({ 18: '' }), qr({ 1: '測試' })]) {
  for (const secret of ['測試', 'A123456789', '0500101', 'TESTCODE01', 'TESTNOTE01']) assert.ok(!rejected(text).includes(secret), secret);
}
console.log('prescription sample failure lines passed');

// A rescan is matched against the scanned text (by its digest), not against the de-identified line.
const key = await scanKey(qr());
assert.match(key, /^[0-9a-f]{64}$/);
assert.equal(await scanKey(qr()), key);
const other = qr({ 4: '測驗', 5: 'B234567890' });
assert.equal(deidentify(other), expected);
assert.notEqual(await scanKey(other), key);
const log = new SampleLog();
assert.deepEqual(log.record(key, qr()), { state: 'added', index: 0 });
assert.deepEqual(log.record(key, qr()), { state: 'duplicate', index: 0 });
assert.deepEqual(log.record(await scanKey(other), other), { state: 'added', index: 1 });
const shortKey = await scanKey(short);
assert.deepEqual(log.record(shortKey, short), { state: 'failed', index: 2 });
assert.deepEqual(log.record(shortKey, short), { state: 'duplicate', index: 2 });
assert.deepEqual([log.collected, log.failed, log.entries.length], [2, 1, 3]);
const failure = '失敗：不是支援的處方 QR 格式，或藥品欄位不完整，欄位數 18';
assert.equal(log.text(), `${expected}\n${expected}\n${failure}\n`);
assert.deepEqual(log.lines(), [expected, expected, failure]);
for (const secret of ['測試', '測驗', 'A123456789', 'B234567890', '0500101', '0099', 'TESTNOTE01', 'TESTVISIT02', key]) assert.ok(!log.text().includes(secret), secret);
// Saved lines carry no key: after a reload a rescan is matched by its de-identified line, and a failure cannot be matched.
const reloaded = new SampleLog();
reloaded.restore(log.lines());
assert.deepEqual([reloaded.collected, reloaded.failed], [2, 1]);
assert.deepEqual(reloaded.record(key, qr()), { state: 'duplicate', index: 0 });
assert.deepEqual(reloaded.record(shortKey, short), { state: 'failed', index: 3 });
const later = qr({ 8: '1150102' });
assert.deepEqual(reloaded.record(await scanKey(later), later), { state: 'added', index: 4 });
assert.deepEqual(reloaded.record(await scanKey(later), later), { state: 'duplicate', index: 4 });
reloaded.clear();
assert.deepEqual([reloaded.text(), reloaded.collected], ['', 0]);
console.log('prescription sample duplicate checks passed');
