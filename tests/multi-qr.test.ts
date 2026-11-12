import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MULTI_QR, multiQRNote, printsMultiQR } from '../src/multi-qr';
import { sampleOf } from '../src/rx-sample';

// The list the weekly review adds to: valid JSON with only these keys, each code a 10-digit 醫事機構代碼 listed once, a date
// when it was first seen and where. A malformed edit fails here rather than on the slip.
const file = JSON.parse(readFileSync('docs/reference/multi-qr-institutions.json', 'utf8'));
assert.deepEqual(Object.keys(file).sort(), ['institutions', '說明'].sort());
assert.ok(MULTI_QR.length > 0);
for (const entry of file.institutions) {
  assert.deepEqual(Object.keys(entry).sort(), ['code', 'since', 'source'], JSON.stringify(entry));
  assert.match(entry.code, /^\d{10}$/, entry.code);
  assert.match(entry.since, /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, entry.code);
  assert.ok(entry.source.trim(), entry.code);
}
assert.equal(new Set(MULTI_QR.map(entry => entry.code)).size, MULTI_QR.length, 'duplicate institution code');
assert.deepEqual(MULTI_QR.map(entry => entry.code), [...MULTI_QR.map(entry => entry.code)].sort(), 'keep the codes in order');

// The institution of the reported prescription is listed; the card says how many QR codes it was read from.
assert.equal(printsMultiQR('1101020018'), true);
assert.equal(printsMultiQR(' 1101020018 '), true);
assert.equal(printsMultiQR('0000000000'), false);
assert.match(multiQRNote(2), /2 個以上的 QR/);
assert.match(multiQRNote(2), /由 2 個 QR 讀入/);

// A prescription joined from linked QR codes counts as one with a second QR in the samples, so the weekly statistics see it.
const line = '0000000000;2;04;測試;A123456789;0990101;AB;1151104;0018;28;B24;I10;0000000000;;TESTCODE01;1;QD;PO;28;';
assert.equal(sampleOf(line).qrs, 1);
assert.equal(sampleOf(line, 2).qrs, 2);
console.log('multi-QR institutions passed');
