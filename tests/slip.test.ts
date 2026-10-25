import assert from 'node:assert/strict';
import { buildSlip, planSlip, prescriptionAhead, productIndex, type SlipEntry, type SlipForm } from '../src/slip-model';
import { readMap, type MapEntry } from '../src/sku-map';
import { csvRows, rosterNames } from '../scripts/roster';

// Synthetic people only. 28 days × 3 from 2026/09/24 is the source slip's prescription.
const entry = (extra: Partial<SlipEntry> = {}): SlipEntry => ({ date: '2026-09-24', days: 28, count: 3, name: '測試甲', idNumber: 'A123456789', birth: '1950-07-17', hospital: '測試醫院', ...extra });
const form: SlipForm = { phone: '0900-000-000', sms: true, call: false, note: '', staff: '測試員', missing: [] };

// Inside the second window: the slip shows the third visit, matching the source slip (有效 12/16, 11/09～11/18 x1).
let plan = planSlip([entry()], '2026-10-15');
assert.equal(plan.validUntil, '2026-12-16');
assert.deepEqual(plan.third, { start: '2026-11-09', end: '2026-11-18', prescriptions: 1 });
assert.equal(plan.second, undefined);
// 10/24 is past the second window: inferred as handed in early for visit 3 unless visit 2 is chosen (late, corrected).
plan = planSlip([entry()], '2026-10-24');
assert.deepEqual(plan.third, { start: '2026-11-09', end: '2026-11-18', prescriptions: 1 });
assert.match(plan.notes[0], /第 1 張：.*提前交付處方預處理/);
plan = planSlip([entry({ visit: 2 })], '2026-10-24');
assert.deepEqual(plan.third, { start: '2026-11-11', end: '2026-11-20', prescriptions: 1 });
assert.deepEqual(plan.notes, []);
// First visit of three: both rows come from the original schedule.
plan = planSlip([entry()], '2026-09-24');
assert.deepEqual([plan.second, plan.third], [{ start: '2026-10-12', end: '2026-10-21', prescriptions: 1 }, { start: '2026-11-09', end: '2026-11-18', prescriptions: 1 }]);
// Late first visit: the third window waits for the corrected second pickup.
plan = planSlip([entry({ visit: 1 })], '2026-10-01');
assert.deepEqual(plan.second, { start: '2026-10-19', end: '2026-10-28', prescriptions: 1 });
assert.equal(plan.third, undefined);
assert.match(plan.notes[0], /第 3 次區間須待第 2 次領藥後再算/);
// Two departments at the same stage: the shared window and x2.
plan = planSlip([entry(), entry({ date: '2026-09-26' })], '2026-10-15');
assert.deepEqual(plan.third, { start: '2026-11-11', end: '2026-11-18', prescriptions: 2 });
// Different stages go by trip: the next trip on the second row, the one after on the third.
plan = planSlip([entry(), entry({ date: '2026-10-15', visit: 1 })], '2026-10-15');
assert.deepEqual(plan.second, { start: '2026-11-09', end: '2026-11-11', prescriptions: 2 });
assert.deepEqual(plan.third, { start: '2026-11-30', end: '2026-12-09', prescriptions: 1 });
assert.equal(plan.validUntil, '2026-12-16'); // The earliest expiry wins.
// Mixed next visits 2 and 3 in one trip use the second row.
plan = planSlip([entry(), entry({ date: '2026-10-15', count: 2, visit: 1 })], '2026-10-15');
assert.deepEqual([plan.second, plan.third], [{ start: '2026-11-09', end: '2026-11-11', prescriptions: 2 }, undefined]);
// No shared day: printing is blocked with every window listed.
assert.throws(() => planSlip([entry(), entry({ date: '2026-10-05' })], '2026-10-15'), /下次找不到共同可領藥日（第 1 張 11\/9～11\/18、第 2 張 10\/23～11\/1）/);
// Last visit: no rows, a return reminder, and no x count.
plan = planSlip([entry({ count: 2 })], '2026-10-15');
assert.deepEqual([plan.second, plan.third], [undefined, undefined]);
assert.match(plan.notes[0], /已無下次領藥/);
// A late last visit only has a return window (the calculator's corrected 下次回診區間): never a pickup row.
for (const [extra, today] of [[{ count: 2 }, '2026-10-24'], [{ visit: 3 }, '2026-11-20']] as const) {
  plan = planSlip([entry(extra)], today);
  assert.deepEqual([plan.second, plan.third], [undefined, undefined]);
  assert.match(plan.notes[0], /已無下次領藥/);
}
plan = planSlip([entry({ count: 2 }), entry()], '2026-10-15');
assert.deepEqual(plan.third, { start: '2026-11-09', end: '2026-11-18', prescriptions: 1 });
assert.throws(() => planSlip([entry({ count: undefined })], '2026-10-15'), /第 1 張請選擇可調劑次數/);
assert.throws(() => planSlip([entry()], '2026-12-20'), /第 1 張：處方已於115\/12\/17失效/);
assert.throws(() => planSlip([], '2026-10-15'), /請先掃描處方 QR/);
assert.equal(prescriptionAhead(entry(), '2026-10-15').visit, 2);

// Family members: every name; IDs and birthdays only for the store copy.
let slip = buildSlip([entry(), entry({ name: '測試乙', idNumber: 'B223456789', birth: '' }), entry({ hospital: '另一醫院' })], form, '2026-10-15');
assert.equal(slip.names, '測試甲、測試乙');
assert.equal(slip.hospitals, '測試醫院、另一醫院');
assert.equal(slip.footer, 'A123456789.19500717　B223456789');
assert.equal(slip.openDate, '2026-10-15');
assert.deepEqual(slip.third, { start: '2026-11-09', end: '2026-11-18', prescriptions: 3 });
slip = buildSlip([entry({ idNumber: '' })], form, '2026-10-15');
assert.equal(slip.footer, '');
assert.throws(() => buildSlip([entry(), entry({ hospital: ' ' })], form, '2026-10-15'), /第 2 張請填寫醫院名稱/);
const item = { code: 'TESTCODE01', name: '', quantity: '28', note: '' };
assert.throws(() => buildSlip([entry()], { ...form, missing: Array(5).fill(item) }, '2026-10-15'), /最多 4 列/);
console.log('pickup slip trips, shared windows, rows and people passed');

// 尚差藥品 from the map (synthetic 六碼): one 健保碼 can have several packs, listed by 六碼; the name drops the package spec
// so it fits the slip, full keeps it to tell the packs apart; 無健保碼 rows map from nothing.
const mapped = (sku: string, code: string, key: string): MapEntry => ({ sku, code, key, verdict: code ? '自動明確' : '無健保碼', date: '2026-10-25', source: '測試' });
const index = productIndex([mapped('900002', 'AB41606100', '1000粒/瓶SINZAC信樂膠囊20MG'), mapped('900001', 'AB41606100', '1000粒/盒(10粒/排)SINZAC信樂膠囊20MG'),
  mapped('900003', 'AC47341100', '100粒/盒(10粒/排)MELSTATIN美脂利錠20MG'), mapped('900004', '', '4粒/盒VIAGRA威而鋼膜衣錠100MG')]);
assert.deepEqual(index.get('AC47341100'), [{ sku: '900003', name: 'MELSTATIN美脂利錠20MG', full: '100粒/盒(10粒/排)MELSTATIN美脂利錠20MG' }]);
assert.deepEqual(index.get('AB41606100')!.map(({ sku, name }) => `${sku} ${name}`), ['900001 SINZAC信樂膠囊20MG', '900002 SINZAC信樂膠囊20MG']);
assert.equal(index.size, 2);
// The slip reads the map file as the scripts do: spreadsheet damage put back, a broken file rejected.
const sheet = '六碼,健保藥品代號,對接品名,判定,判定日期,來源\n';
assert.deepEqual(productIndex(readMap(sheet + '9001,ac47341100,"100粒/盒(10粒/排)MELSTATIN美脂利錠20MG",自動明確,2026/10/25,測試\n').values()).get('AC47341100'),
  [{ sku: '009001', name: 'MELSTATIN美脂利錠20MG', full: '100粒/盒(10粒/排)MELSTATIN美脂利錠20MG' }]);
assert.throws(() => readMap('醫事機構代碼,醫事機構名稱\n'), /對照檔欄位應為/);
console.log('pickup slip products from the map passed');

// Roster CSV: quoted fields, restored leading zeros, unrecoverable spreadsheet codes skipped, other kinds ignored.
assert.deepEqual(csvRows('a,"b,""c"""\r\n\r\n"d\ne",f\n'), [['a', 'b,"c"'], ['d\ne', 'f']]);
const roster = rosterNames('﻿醫事機構代碼,醫事機構名稱,醫事機構種類\n101090517,"測試醫院,總院",A\n350102A009,測試診所,A\n3.50E+12,壞代碼診所,A\n5901010012,測試藥局,B\n');
assert.deepEqual(roster.names, { '0101090517': '測試醫院,總院', '350102A009': '測試診所' });
assert.deepEqual(roster.skipped, ['3.50E+12 壞代碼診所']);
assert.throws(() => rosterNames('代碼,名稱\n1,2\n'), /名冊缺少欄位：醫事機構代碼/);
console.log('institution roster conversion passed');
