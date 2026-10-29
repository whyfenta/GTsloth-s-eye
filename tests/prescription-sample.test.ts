import assert from 'node:assert/strict';
import { parsePrescription, parsePrescriptionLayout, splitFields } from '../src/prescription-qr';
import { SampleLog, ageBand, deidentify, deidentifyDrugs, failureLine, scanKey } from '../src/prescription-sample';

// Synthetic placeholders only, never a real prescription. Field numbers count from 1, as in the README.
const fields = ['0000000000', '1', '12', '測試', 'A123456789', '0500101', '345', '1150101', '0099', '7', 'Z9', 'TESTDX.1#TESTDX2#', '0000000000',
  '9,TESTNOTE01,過敏史:藥物甲,TESTVISIT02', 'TESTCODE01', '1', 'BID', 'PO', '14', 'TESTCODE02', 'X1', 'QID', 'OS', '1'];
const qr = (changes: Record<number, string> = {}) => fields.map((value, i) => changes[i + 1] ?? value).join(';') + ';';
const field = (text: string, n: number) => splitFields(deidentify(text))[n - 1];
const expected = '0000000000;1;12;;;AGE65-69;345;1150101;;7;Z9;TESTDX.1#TESTDX2#;0000000000;過敏史:藥物甲;TESTCODE01;1;BID;PO;14;TESTCODE02;X1;QID;OS;1;';
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
// Drug fields stay as scanned. Only a blank drug code is refused; a blank dose, frequency, route or total stays a blank field.
assert.equal(field(qr({ 16: '.5', 19: 'X1' }), 19), 'X1');
for (const n of [16, 17, 18, 19, 21, 22, 23, 24]) for (const value of ['', ' ']) assert.equal(field(qr({ [n]: value }), n), value, `第 ${n} 欄`);
const sparse = qr({ 16: '', 17: '', 18: '', 19: '', 22: '', 23: '' });
assert.equal(deidentify(sparse), expected.replace(';TESTCODE01;1;BID;PO;14;', ';TESTCODE01;;;;;').replace(';X1;QID;OS;', ';X1;;;'));
assert.equal(splitFields(deidentify(sparse)).length, fields.length);
// The 試算 and 憑單 parsers still refuse any blank drug field.
assert.throws(() => parsePrescription(qr({ 2: '2', 10: '28', 18: '' })));
console.log('prescription sample field rules passed');

// Field 6: completed years on the visit date, 10 years a band, with 60–69 split at 65.
const visit = '1150101'; // 2026-01-01
for (const [birth, band] of [['1150101', 'AGE0-9'], ['1050102', 'AGE0-9'], ['1050101', 'AGE10-19'], ['0950102', 'AGE10-19'], ['0950101', 'AGE20-29'],
  ['0550102', 'AGE50-59'], ['0550101', 'AGE60-64'], ['0500102', 'AGE60-64'], ['0500101', 'AGE65-69'], ['0450102', 'AGE65-69'], ['0450101', 'AGE70-79'],
  ['0250102', 'AGE80-89'], ['0250101', 'AGE90+'], ['0010101', 'AGE90+'], [' 1050101 ', 'AGE10-19']]) assert.equal(ageBand(birth, visit), band, birth);
// Born on 2016-02-29: still 9 on 2026-02-28, 10 on 2026-03-01. Born on 1961-02-28: 64 the day before, 65 that day.
assert.deepEqual([ageBand('1050229', '1150228'), ageBand('1050229', '1150301')], ['AGE0-9', 'AGE10-19']);
assert.deepEqual([ageBand('0500228', '1150227'), ageBand('0500228', '1150228')], ['AGE60-64', 'AGE65-69']);
// A blank birth date, one after the visit, or an unreadable visit date leaves the field blank.
for (const birth of ['', '   ', '1150102']) assert.equal(ageBand(birth, visit), '', birth);
assert.equal(ageBand('1050101', '1150230'), '');
// A birth date that cannot be read leaves its shape only: digits 9, letters A, other non-ASCII X, symbols kept; past 12 characters, the length.
for (const [birth, shape] of [['19610101', 'AGE?99999999'], ['1961/01/01', 'AGE?9999/99/99'], ['050/01/01', 'AGE?999/99/99'], ['民國50年1月1日', 'AGE?XX99X9X9X'],
  ['０５００１０１', 'AGE?XXXXXXX'], ['1051301', 'AGE?9999999'], ['1050230', 'AGE?9999999'], ['0000101', 'AGE?9999999'], ['501231', 'AGE?999999'], ['TESTVAL', 'AGE?AAAAAAA'],
  ['1961-01-01AM', 'AGE?9999-99-99AA'], ['1961-01-01 AM', 'AGE?len13'], ['1961-01-01T00:00:00', 'AGE?len19'], ['050\n0101', 'AGE?999X9999']]) {
  assert.equal(ageBand(birth, visit), shape, birth);
  const line = deidentify(qr({ 6: birth }));
  assert.equal(splitFields(line)[5], shape, birth);
  assert.equal(splitFields(line).length, fields.length);
  for (const original of [birth, birth.trim(), '1961', '民國']) assert.ok(!line.includes(original), `${birth} 原值不可輸出`);
}
assert.equal(ageBand('19610101', '1150230'), 'AGE?99999999');
const shapes = new SampleLog();
for (const birth of ['19610101', '1961/01/01', '民國50年1月1日']) shapes.record(birth, qr({ 6: birth }));
assert.deepEqual([shapes.collected, shapes.text().split('\n').length], [3, 4]);
for (const original of ['19610101', '1961/01/01', '民國50年1月1日', '1961', '民國']) assert.ok(!shapes.text().includes(original), original);
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
assert.equal(rejected(qr({ 15: '' })), '失敗：QR 藥品健保碼空白，欄位數 24');
assert.equal(rejected(qr({ 20: ' ' })), '失敗：QR 藥品健保碼空白，欄位數 24');
assert.equal(rejected(qr({ 4: '�' })), '失敗：QR 文字不完整或含亂碼，請重新掃描，欄位數 24');
// Chinese in a kept field means another layout, which could put a name there.
for (const n of [1, 2, 8, 10, 12]) assert.equal(rejected(qr({ [n]: '測試' })), `失敗：第 ${n} 欄出現中文或全形字，可能是不同院所的 QR 格式，欄位數 24`);
assert.equal(failureLine(qr(), 'not an error'), '失敗：無法解析，欄位數 24');
// A retained allergy or drug field cannot split one prescription across output lines.
for (const newline of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
  for (const n of [14, 15, 16, 17, 18, 19]) {
    const value = n === 14 ? '過敏史:藥物甲' : fields[n - 1];
    const text = qr({ [n]: `${value}${newline}TESTSECRET` });
    const failed = new SampleLog();
    assert.equal(failed.record('newline', text).state, 'failed');
    assert.equal(failed.lines()[0], '失敗：保留欄位含換行，無法輸出單行樣本，欄位數 24');
    assert.equal(failed.text().split('\n').length, 2);
    assert.ok(!failed.text().includes('TESTSECRET'));
  }
}
for (const text of [short, qr({ 15: '' }), qr({ 1: '測試' })]) {
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
// A prescription with many drugs has a drugs-only second QR: it joins the line before it, counted per institution.
const drugsQR = 'TESTCODE03;1;;PO;28;TESTCODE04;X1;QD;OU;1;';
assert.equal(deidentifyDrugs(drugsQR), drugsQR);
assert.equal(deidentifyDrugs(qr()), undefined);
assert.throws(() => deidentifyDrugs(';1;QD;PO;28;'));
const multi = new SampleLog();
const drugsKey = await scanKey(drugsQR);
assert.deepEqual(multi.record(drugsKey, drugsQR), { state: 'failed', index: 0 });
assert.match(multi.lines()[0], /^失敗：只有藥品的第 2 個 QR，但前一張不是成功收下的處方，欄位數 10$/);
multi.clear();
assert.deepEqual(multi.record(key, qr()), { state: 'added', index: 0 });
assert.deepEqual(multi.record(drugsKey, drugsQR), { state: 'appended', index: 0, drugs: 2 });
assert.deepEqual(multi.record(drugsKey, drugsQR), { state: 'duplicate', index: 0 });
assert.equal(multi.lines()[0], expected + drugsQR);
assert.equal(parsePrescriptionLayout(multi.lines()[0]).fields.length, fields.length + 10);
const otherClinic = qr({ 1: '1111111111', 13: '1111111111' });
assert.deepEqual(multi.record(await scanKey(otherClinic), otherClinic), { state: 'added', index: 1 });
assert.deepEqual(multi.record(await scanKey(later), later), { state: 'added', index: 2 });
assert.deepEqual([multi.collected, multi.multi], [3, 1]);
assert.deepEqual(multi.institutions(), [{ institution: '0000000000', prescriptions: 2, multi: 1 }]);
// After a reload the QR counts come back with the lines; rescans of either QR are still duplicates.
const multiReloaded = new SampleLog();
multiReloaded.restore(multi.lines(), multi.qrs());
assert.deepEqual(multiReloaded.institutions(), multi.institutions());
assert.deepEqual(multiReloaded.record(key, qr()), { state: 'duplicate', index: 0 });
const lastOne = new SampleLog();
lastOne.restore(multi.lines().slice(0, 1), multi.qrs().slice(0, 1));
assert.deepEqual(lastOne.record(drugsKey, drugsQR), { state: 'duplicate', index: 0 });
console.log('prescription sample duplicate checks passed');
