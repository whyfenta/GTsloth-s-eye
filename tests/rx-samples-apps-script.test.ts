import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { deidentify, failureLine } from '../src/prescription-sample';
import { sampleOf, sampleRecords, SAMPLE_FORMAT } from '../src/rx-sample';

// docs/rx-samples-apps-script.gs runs here against small fakes of the Google services it uses. Synthetic lines only.
type Row = string[];
class FakeSheet {
  rows: Row[] = [];
  constructor(public name: string) {}
  getName() { return this.name; }
  setName(name: string) { this.name = name; }
  getLastRow() { return this.rows.length; }
  setFrozenRows() {}
  // Array.from: rows the script builds belong to its own realm, which deepEqual tells apart.
  appendRow(row: unknown[]) { this.rows.push(Array.from(row, String)); }
  deleteRows(at: number, count: number) { this.rows.splice(at - 1, count); }
  getDataRange() { return { getValues: () => this.rows.map(row => [...row]) }; }
  getRange(row: number, column: number, rows = 1, columns = 1) {
    const range = {
      setNumberFormat: () => range,
      setValues: (values: unknown[][]) => {
        assert.equal(values.length, rows); values.forEach(value => assert.equal(value.length, columns));
        values.forEach((value, i) => { const target = this.rows[row - 1 + i] ??= []; value.forEach((v, j) => { target[column - 1 + j] = String(v); }); });
        return range;
      },
      setValue: (value: unknown) => range.setValues([[value]]),
      getValue: () => this.rows[row - 1]?.[column - 1] ?? '',
      getValues: () => Array.from({ length: rows }, (_, i) => Array.from({ length: columns }, (_, j) => this.rows[row - 1 + i]?.[column - 1 + j] ?? '')),
    };
    return range;
  }
}
class FakeFolder {
  folders: FakeFolder[] = []; files: { name: string; text: string }[] = []; moved: string[] = [];
  constructor(public name: string) {}
  getFoldersByName(name: string) { const found = this.folders.filter(f => f.name === name); return { hasNext: () => found.length > 0, next: () => found.shift()! }; }
  createFolder(name: string) { const created = new FakeFolder(name); this.folders.push(created); return created; }
  createFile(name: string, text: string) { this.files.push({ name, text }); }
}
function load() {
  const sheets: FakeSheet[] = [new FakeSheet('工作表1')];
  const root = new FakeFolder('GTsloth 處方樣本（去識別化）');
  root.createFolder('驗證用');
  const docs: { title: string; text: string }[] = [];
  const triggers: string[] = [];
  const clock = { now: '2026-11-02 10:00:00' };
  const book = {
    getId: () => 'BOOK', getSheets: () => sheets, getSheetByName: (name: string) => sheets.find(s => s.name === name) ?? null,
    insertSheet: (name: string) => { const created = new FakeSheet(name); sheets.push(created); return created; },
  };
  let uuids = 0;
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => book },
    DriveApp: { getFileById: (id: string) => ({ getParents: () => ({ next: () => root }), moveTo: (folder: FakeFolder) => folder.moved.push(id), getUrl: () => `https://docs.example/${id}` }) },
    DocumentApp: { create: (title: string) => { const doc = { title, text: '' }; docs.push(doc); return { getId: () => `DOC${docs.length}`, getBody: () => ({ setText: (text: string) => { doc.text = text; } }), saveAndClose() {} }; } },
    Utilities: {
      formatDate: () => clock.now, getUuid: () => `${String(++uuids).padStart(8, '0')}-uuid`,
      computeDigest: (_: unknown, text: string) => [...createHash('sha256').update(text, 'utf8').digest()].map(byte => byte > 127 ? byte - 256 : byte),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    },
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: (text: string) => ({ setMimeType: () => text }), MimeType: { TEXT: 'TEXT' } },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    ScriptApp: {
      getProjectTriggers: () => triggers.map(name => ({ getHandlerFunction: () => name })), deleteTrigger: (t: { getHandlerFunction(): string }) => triggers.splice(triggers.indexOf(t.getHandlerFunction()), 1),
      newTrigger: (name: string) => ({ timeBased: () => ({ onWeekDay: () => ({ atHour: () => ({ create: () => triggers.push(name) }) }) }) }), WeekDay: { MONDAY: 'MONDAY' },
    },
    Logger: { log() {} },
  });
  vm.runInContext(readFileSync('docs/rx-samples-apps-script.gs', 'utf8'), context);
  // A later script in the same context sees the file's top-level const functions too, which the context object does not hold.
  const call = <T>(name: string, ...args: unknown[]) => (vm.runInContext(name, context) as (...a: unknown[]) => T)(...args);
  return { call, sheets, root, docs, triggers, clock, sheet: (name: string) => sheets.find(s => s.name === name)! };
}

// A QR as a hospital prints it; the collector's line for it is what the page sends.
const qr = (changes: Record<number, string> = {}, codes = ['TESTCODE01']) => {
  const fields = ['0101010101', '2', '12', '測試', 'A223456789', '0650101', 'AB', '1151101', '0099', '28', 'Z9', 'E11.9#I10#', '0101010101', '9,過敏史:藥物甲,TESTNOTE01',
    ...codes.flatMap(code => [code, '1', 'BID', 'PO', '56'])];
  for (const [n, value] of Object.entries(changes)) fields[Number(n) - 1] = value;
  return fields.join(';') + ';';
};
const gs = load();
const problem = (line: unknown) => gs.call<string>('lineProblem', line);

// Every line the collector writes passes; birth dates it cannot read leave only a shape, which passes too.
for (const changes of [{}, { 5: '' }, { 5: 'A923456789' }, { 6: '' }, { 6: '1150101' }, { 6: '99/01/01' }, { 6: '民國五十年' }, { 6: '0123456789012345' }, { 3: '', 7: '146', 11: '' },
  { 13: '' }, { 14: '' }, { 14: '過敏史:無' }, { 7: 'AB00' }, { 6: '0050101' }, { 6: '0200101' }] as Record<number, string>[]) {
  const line = deidentify(qr(changes));
  assert.equal(problem(line), '', `${JSON.stringify(changes)} → ${line}`);
}
assert.equal(problem(deidentify(qr({}, ['TESTCODE01', 'TESTCODE02', 'TESTCODE03']))), '');
// Anything the collector would never write is turned down, with the reason only.
const good = deidentify(qr());
const field = (n: number, value: string) => { const f = good.slice(0, -1).split(';'); f[n - 1] = value; return f.join(';') + ';'; };
for (const [line, reason] of [
  [field(4, '測試'), '第 4 欄（姓名）不是空白'], [field(4, 'TESTNAME'), '第 4 欄（姓名）不是空白'], [field(5, 'A223456789'), '第 5 欄不是性別標記'],
  [field(5, '2'), '第 5 欄不是性別標記'], [field(6, '0650101'), '第 6 欄不是年齡層'], [field(6, 'AGE?0650101'), '第 6 欄不是年齡層'],
  [field(6, 'AGE?TESTNAME'), '第 6 欄不是年齡層'], [field(9, '0099'), '第 9 欄不是空白'], [field(1, '測試院所'), '第 1 欄不是半形英數'],
  [field(8, '一一五'), '第 8 欄不是半形英數'], [field(12, 'E11 測試'), '第 12 欄不是半形英數'], [field(3, 'TESTV'), '第 3 欄超過 4 碼英數'],
  [field(13, '9999999999'), '第 13 欄與第 1 欄不同'], [field(14, '9,過敏史:無'), '第 14 欄不是過敏史'], [field(15, ' '), '藥品健保碼空白'],
  [good.slice(0, -1), '結尾不是分號'], [good + 'X;', '欄位數 20'], [good.replace('BID', 'B\nID'), '含換行'], ['', '長度不符'], [42, '長度不符'],
] as [unknown, string][]) assert.equal(problem(line), reason, String(line));
// Failure lines: a reason and a field count, nothing else.
assert.equal(gs.call('failureProblem', failureLine(qr({ 1: '測試院所' }), new Error('第 1 欄出現中文或全形字。'))), '');
assert.equal(gs.call('failureProblem', '失敗：測試，欄位數 3;A223456789'), '失敗行格式不符');
assert.equal(gs.call('failureProblem', 'A223456789'), '失敗行格式不符');
for (const [record, reason] of [[{}, 'format'], [{ format: SAMPLE_FORMAT, version: 2, prescriptions: [], failed: [] }, 'format'], [{ format: SAMPLE_FORMAT, version: 1, prescriptions: [], failed: [] }, 'empty'],
  [{ format: SAMPLE_FORMAT, version: 1, prescriptions: Array(21).fill({ line: good, qrs: 1 }), failed: [] }, 'items'], [{ format: SAMPLE_FORMAT, version: 1, prescriptions: {}, failed: [] }, 'items']] as [unknown, string][])
  assert.equal(gs.call('recordProblem', record), reason);

// setup() names the first sheet, makes the other two and the review folder, and installs one Monday trigger however often it runs.
gs.call('setup'); gs.call('setup');
assert.deepEqual(gs.sheets.map(s => s.name), ['樣本', '失敗', '每週統計']);
assert.deepEqual(gs.root.folders.map(f => f.name), ['驗證用', '每週檢查']);
assert.deepEqual(gs.triggers, ['weekly']);
gs.call('selfTest');
assert.equal(gs.sheet('樣本').rows.length, 1, 'selfTest leaves no row behind');

// doPost writes what the page sends: lines with their checks, server-side rejections and failures by reason only.
const post = (record: unknown) => gs.call<string>('doPost', { postData: { contents: JSON.stringify(record) } });
const second = deidentify(qr({ 8: '1151102', 12: 'F41.1#' }, ['TESTALPR01']));
const [record] = sampleRecords([sampleOf(qr()), { line: second, qrs: 2 }], ['失敗：測試原因，欄位數 3'], undefined, '1.4.0', '2026-11-01T01:00:00.000Z');
record.rules = 'abcdef012345';
record.prescriptions[1].check = { top: '黃', alerts: ['黃 TESTALPR01 N05BA12 =測試 | 理由'], cautions: ['T01黃'], unexplained: ['TESTALPR01 N05BA12'], unknownDrugs: [], unknownDx: ['X99 查無'] };
// 對照檔查無 keeps only codes on the line; 合併多出 only rule numbers with a level.
record.prescriptions[0].unmapped = ['TESTCODE01', 'A223456789', 'TESTCODE01'];
record.prescriptions[0].merged = ['T01紅', '同成分重複黃', 'A223456789', '第 2 張 T01紅'];
record.prescriptions[1].unmapped = ['TESTALPR01'];
record.prescriptions[1].check.unknownDrugs = ['TESTALPR01'];
record.prescriptions.push({ line: field(4, '測試'), qrs: 1 });
gs.clock.now = '2026-10-28 09:00:00';
assert.equal(post(record), 'ok');
assert.equal(post({ ...record, version: 9 }), 'rejected: format');
assert.equal(gs.call('doPost', { postData: { contents: 'x'.repeat(100001) } }), 'rejected: size');
assert.equal(gs.call('doPost', { postData: { contents: '{' } }), 'error');
const samples = gs.sheet('樣本').rows, header = samples[0];
const at = (row: Row, name: string) => row[header.indexOf(name)];
assert.equal(samples.length, 3);
assert.deepEqual([at(samples[1], '醫事機構代碼'), at(samples[1], '科別'), at(samples[1], '年齡層'), at(samples[1], '性別'), at(samples[1], '診斷碼'), at(samples[1], '藥品數'), at(samples[1], '規則版本')],
  ['0101010101', 'AB', 'AGE50-59', 'SEXF', 'E11.9#I10#', '1', '']);
assert.equal(at(samples[2], '規則版本'), 'abcdef012345', 'only a checked line has a rules version');
assert.equal(at(samples[1], '去識別化內容'), deidentify(qr()));
assert.equal(at(samples[1], '內容摘要'), createHash('sha256').update(deidentify(qr())).digest('hex'));
assert.deepEqual([at(samples[2], '最高等級'), at(samples[2], '警示'), at(samples[2], 'QR數'), at(samples[2], '查無診斷')], ['黃', "'黃 TESTALPR01 N05BA12 =測試／理由".slice(1), '2', 'X99 查無']);
assert.deepEqual([at(samples[1], '對照檔查無'), at(samples[1], '合併多出'), at(samples[2], '對照檔查無'), at(samples[2], '合併多出')], ['TESTCODE01', 'T01紅 | 同成分重複黃', 'TESTALPR01', '']);
assert.deepEqual(Array.from(gs.call<string[]>('mergedOf', ['C56黃', 'C56黃', '同成分重複灰', 'C56', '黃', 42])), ['C56黃', '同成分重複灰']);
assert.deepEqual(Array.from(gs.call<string[]>('mergedOf', 'C56黃')), []);
assert.deepEqual(gs.sheet('失敗').rows.slice(1).map(row => row[3]), ['伺服器拒收：第 4 欄（姓名）不是空白', '失敗：測試原因，欄位數 3']);
assert.ok(!gs.sheets.some(s => s.rows.some(row => row.some(value => value.includes(';測試;')))), 'the rejected line, name and all, never reaches a sheet');
for (const secret of ['A223456789', '0650101', 'TESTNOTE01', '0099']) assert.ok(!JSON.stringify(gs.sheets.map(s => s.rows)).includes(secret), secret);

// weekly(): the new lines go to 驗證用 once, repeats are marked, and the summary names what needs a look.
gs.clock.now = '2026-11-02 03:00:00';
assert.equal(gs.call('weekly'), '週檢查資料_20261102');
const validation = gs.root.folders[0], review = gs.root.folders[1];
assert.deepEqual(validation.files, [{ name: '處方QR去識別化_自動_20261028-20261102_2張.txt', text: `${deidentify(qr())}\n${second}\n` }]);
assert.deepEqual(review.moved, ['DOC1']);
const summary = gs.docs[0].text;
assert.match(summary, /收到 2 張，重複 0 張.*不重複 2 張；失敗 2 行。/);
assert.match(summary, /院所 1 家，其中先前沒出現過的 1 家。/);
assert.match(summary, /紅 0 張、黃 1 張（黃紅比例 100\.0%）.*沒有判定摘要（規則資料未載入）1 張/);
assert.match(summary, /1\. \[黃\] 院所 0101010101・科別 AB・AGE50-59・SEXF・診斷 F41\.1#\n {3}- 黃 TESTALPR01 N05BA12 =測試／理由\n {3}行：/);
assert.match(summary, /- N05BA12：1 次、1 家院所；同時出現的診斷（前 3 碼）：F41 ×1；科別：AB ×1\n {2}範例：/);
assert.match(summary, /## 注意事項命中（編號＋等級）\n- T01黃 ×1/);
assert.match(summary, /## 同一病人合併比對多出的注意事項（1 張處方；[^\n]*\n- T01紅 ×1\n- 同成分重複黃 ×1/);
assert.match(summary, /## 同一病人的多張處方（批次蒐集匯入，同一批次是同一病人；0 位病人）\n（無）/);
assert.match(summary, /## 對照檔查無此健保碼：健保品項查得到，六碼對照檔沒有（請補 sku-nhi-map\.csv）\n- TESTCODE01 ×1\n/);
assert.match(summary, /## 對照檔查無此健保碼：健保品項也查無[^\n]*\n- TESTALPR01 ×1\n/);
assert.match(summary, /- 伺服器拒收：第 4 欄（姓名）不是空白 ×1/);
assert.match(summary, /## 有第 2 個 QR 的院所（張數）\n- 0101010101 ×1/);
assert.ok(gs.sheet('樣本').rows.slice(1).every(row => at(row, '匯出檔') === '處方QR去識別化_自動_20261028-20261102_2張.txt' && at(row, '重複於') === ''));
assert.ok(gs.sheet('失敗').rows.slice(1).every(row => row[4] === '週檢查資料_20261102'));
assert.deepEqual(gs.sheet('每週統計').rows[1].slice(0, 12), ['2026-11-02 03:00:00', '2026-10-28', '2026-11-02', '2', '0', '2', '1', '1', '0', '1', '100.0%', 'abcdef012345']);
// The next week: a refill of the same prescription is a repeat of its row, not exported again; a known institution is not new.
const [next] = sampleRecords([sampleOf(qr()), sampleOf(qr({ 1: '0202020202', 13: '' }))], [], undefined, '1.4.0', 't');
gs.clock.now = '2026-11-05 12:00:00';
post(next);
gs.clock.now = '2026-11-09 03:00:00';
gs.call('weekly');
assert.deepEqual(validation.files[1], { name: '處方QR去識別化_自動_20261105-20261109_1張.txt', text: `${deidentify(qr({ 1: '0202020202', 13: '' }))}\n` });
assert.deepEqual(gs.sheet('樣本').rows.slice(3).map(row => at(row, '重複於')), ['2', '']);
assert.match(gs.docs[1].text, /收到 2 張，重複 1 張.*不重複 1 張；失敗 0 行。\n院所 1 家，其中先前沒出現過的 1 家。/);
// A week with nothing new writes a row of zeros and no file.
assert.equal(gs.call('weekly'), 'nothing new');
assert.equal(validation.files.length, 2);
assert.equal(gs.docs.length, 2);
// 批次蒐集: one patient's prescriptions come in a request of their own, marked after the app version, so they share a 批次 and
// are listed together, a repeat among them too; a marked request of one prescription is not a group.
const [patientRecord] = sampleRecords([sampleOf(qr({ 1: '0303030303', 13: '' })), sampleOf(qr({ 1: '0404040404', 13: '' }))], [], undefined, 'v1.5.0 批次 同一病人', 't');
patientRecord.prescriptions[1].merged = ['同成分重複黃'];
const [lone] = sampleRecords([sampleOf(qr({ 1: '0505050505', 13: '' }))], [], undefined, 'v1.5.0 批次 同一病人', 't');
gs.clock.now = '2026-11-10 21:00:00';
post(patientRecord); post(lone);
gs.clock.now = '2026-11-16 03:00:00';
gs.call('weekly');
const patientSection = gs.docs[2].text.split('## 同一病人的多張處方')[1].split('\n## ')[0];
assert.match(patientSection, /；1 位病人）\n1\. 批次 \S+・2 張・AGE50-59・SEXF\n {3}- \[未判定\] 院所 0303030303・[^\n]*\n {5}行：0303030303;[^\n]*\n {3}- \[未判定\] 院所 0404040404・[^\n]*・合併多出 同成分重複黃\n {5}行：0404040404;/);
assert.ok(!patientSection.includes('0505050505'));
// A sheet made before 對照檔查無 and 合併多出 gets the two names on the next write; its rows stay as they were.
const older = load();
older.call('setup');
const sheet = older.sheet('樣本');
sheet.rows[0] = sheet.rows[0].slice(0, -2);
sheet.rows.push(Array(sheet.rows[0].length).fill('舊'));
older.call('doPost', { postData: { contents: JSON.stringify(next) } });
assert.deepEqual(sheet.rows[0], header);
assert.equal(sheet.rows[1].length, header.length - 2);
console.log('rx-samples Apps Script tests passed');
