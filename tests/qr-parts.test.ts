import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jsQR from 'jsqr';
// @ts-expect-error A plain .mjs script without types.
import { MARK, patchJsQR } from '../scripts/patch-jsqr.mjs';
import { firstPart, parsePrescriptionDrugs, parsePrescriptionSlip, prescriptionText } from '../src/prescription-qr';
import { QRParts, structuredAppend } from '../src/qr-parts';

// The installed jsQR has the Structured Append patch (npm install runs it); patching again changes nothing, and a source
// without the expected decoder loop is refused rather than left as it is.
const source = readFileSync('node_modules/jsqr/dist/jsQR.js', 'utf8');
assert.ok(source.includes(MARK), 'jsQR 未加上 Structured Append 支援：請重新執行 npm install');
assert.equal(patchJsQR(source), source);
assert.throws(() => patchJsQR('function decode() {}'), /jsqr 版本/);

// A synthetic prescription (placeholder fields only, 9 drugs) printed as 2 linked QR codes (version 7, 45 modules a side),
// cut where the first is full, inside a drug's fields, as the hospital in question prints them.
const TEXT = '0000000000;2;04;測試;A1********;0990101;AB;1151104;0018;28;B24;R0789#I10#E119#E785;0000000000;;TESTCODE01;1;QD;PO;28;TESTCODE02;1;QD;PO;28;TESTCODE03;1;QD;PO;28;TESTCODE04;1;QD;PO;28;TESTCODE05;1;QD;PO;28;TESTCODE06;1;QD;PO;28;TESTCODE07;1;QD;PO;28;TESTCODE08;1;QD;PO;28;TESTCODE09;1;QD;PO;28;';
const SYMBOLS = [[
  '1fd0ec31117f', '10496b24da41', '17547cbaa25d', '175f345d6b5d', '175041f0175d', '10433b178041', '1fd55555557f', '0001eb168e00',
  '1e5139f4739d', '0d8104a11014', '07e74aecd545', '1d2b7fc91495', '0843933eb5ec', '04819986927b', '1e7a224f079e', '138028206d27',
  '114a4e29de89', '17af7e4a52a3', '137906720a22', '1596a507a27b', '0ff0d5f4e9ff', '031e0b154d16', '0d50f1543f55', '11199b190111',
  '03f9d7fe0ff4', '01159b87dc91', '02f5a1f144a0', '1baeea82492c', '0c46189a7f43', '100014cd4250', '0f429faca55a', '1c964be7ae89',
  '1df81e6471b0', '0d0d39353fc6', '01767838d375', '0f30dc831e98', '136f31fa83f8', '001a891eb91a', '1fcb115b875e', '1041091b5d15',
  '1746ddf5f7f9', '17541d487092', '175e94ba11e8', '1056450fb97e', '1fd2e6a8c4d2',
], [
  '1fcd4cf7717f', '104d99a40a41', '175b99efe25d', '174b2f2a235d', '174215fff75d', '10479b188841', '1fd55555557f', '001d65101000',
  '1df203ff4ec4', '189066a21269', '1e5a65b757b9', '1a2f66c9082d', '00d432b87b79', '1a80461dae2a', '17e256c9bbf8', '0f90879280ad',
  '02df66979799', '09acb218d8c0', '036e6fcb99bd', '192560902090', '17f45dfd7ff4', '01170b19491b', '1d559755b559', '0914c7111119',
  '15f3a3f4c7fd', '170a95259452', '13e75ff95957', '1dae4b011382', '055d2de4446f', '1eb653a51779', '08635dd95868', '160803b222ed',
  '096155e47469', '1f3122a15060', '0154fcd594dd', '0f0103aa2848', '137665f84bf9', '001f251d1d11', '1fd29f59db5e', '1052c913a31a',
  '175baff595ff', '1746ba91d1a0', '175bef9d9cbd', '105aa1bab9e1', '1fd9dc999975',
]].map(rows => rows.map(row => BigInt(`0x${row}`).toString(2).padStart(45, '0')));
function draw(rows: string[], scale = 6) {
  const size = (rows.length + 8) * scale, data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const on = rows[Math.floor(y / scale) - 4]?.[Math.floor(x / scale) - 4] === '1', p = (y * size + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = on ? 20 : 235;
    data[p + 3] = 255;
  }
  return jsQR(data, size, size, { inversionAttempts: 'dontInvert' });
}
const codes = SYMBOLS.map(rows => draw(rows));
const parts = codes.map(code => structuredAppend(code!.chunks));
assert.deepEqual(parts.map(part => part && [part.index, part.total]), [[0, 2], [1, 2]]);
assert.equal(parts[0]!.parity, parts[1]!.parity);
const bytes = codes.map(code => Uint8Array.from(code!.binaryData));
const texts = bytes.map(item => new TextDecoder().decode(item));
assert.equal(texts.join(''), TEXT);
// Each code alone is no prescription: the first is cut inside a drug and the second starts there.
assert.ok(!/;$/.test(texts[0]) || !texts[1].startsWith('TESTCODE'), 'the fixture must be cut inside a drug');
assert.throws(() => parsePrescriptionSlip(texts[0]));
// The second can even look like a drugs-only QR whose first code is the tail of a cut one (3 of TESTCODE03): read alone it
// would add a drug that is not there, so the slip joins it to the first part it holds before anything else.
assert.equal(parsePrescriptionDrugs(texts[1])?.drugs[0].code, '3');

// The camera joins them in order, whichever is read first and however often; the joined text is the whole prescription.
let collector = new QRParts();
assert.equal(collector.add(bytes[1], parts[1]!), undefined);
assert.equal(collector.add(bytes[1], parts[1]!), undefined);
assert.deepEqual(collector.progress, { read: 1, total: 2 });
const joined = collector.add(bytes[0], parts[0]!);
assert.ok(joined);
assert.equal(prescriptionText(joined), TEXT);
const slip = parsePrescriptionSlip(TEXT);
assert.equal(slip.drugCount, 9);
assert.deepEqual(slip.drugs.at(-1), { code: 'TESTCODE09', total: '28' });
assert.deepEqual(collector.progress, { read: 0, total: 0 });
// A code of another message (another parity or number of codes) starts over with it.
collector = new QRParts();
collector.add(bytes[0], { ...parts[0]!, parity: parts[0]!.parity ^ 1 });
assert.equal(collector.add(bytes[1], parts[1]!), undefined);
assert.deepEqual(collector.progress, { read: 1, total: 2 });
assert.equal(collector.add(bytes[0], { ...parts[0]!, total: 3 }), undefined);
assert.deepEqual(collector.progress, { read: 1, total: 3 });
// A plain QR has no Structured Append header; nor does a header claiming a single code.
assert.equal(structuredAppend([{ type: 'byte' }]), undefined);
assert.equal(structuredAppend([{ type: 'structuredappend', index: 0, total: 1, parity: 0 }]), undefined);

// A keyboard scanner typing each code on its own: the first is held as a first part, the second is not one.
assert.equal(firstPart(texts[0]), true);
assert.equal(firstPart(texts[1]), false);
assert.equal(firstPart(TEXT), false);
// A first code cut exactly between two drugs is a prescription by itself, its rest a drugs-only QR.
const cut = TEXT.indexOf('TESTCODE06');
assert.equal(firstPart(TEXT.slice(0, cut)), false);
assert.equal(parsePrescriptionSlip(TEXT.slice(0, cut)).drugCount, 5);
assert.equal(parsePrescriptionDrugs(TEXT.slice(cut))?.drugs.length, 4);
console.log('qr structured append passed');
