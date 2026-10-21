import test from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, parseDay, printedDay, today } from '../src/report-date';
import { inventoryWarning } from '../src/model';

const day = (text: string) => parseDay(text)!;
test('printed dates require their label, accept report/OCR spacing, and reject impossible dates', () => {
  assert.deepEqual(printedDay('報表編號: w_im1c1_1 列印時間：2026/10/18 下午 05:23:36'), day('20261018'));
  assert.deepEqual(printedDay('列 印 時 間 : ２０２６ / ２ / ２８ 09:00'), day('20260228'));
  assert.deepEqual(printedDay('列印日期：2024年2月29日'), day('20240229'));
  for (const text of ['列印時間：2026/02/29', '列印日期：2026/13/01', '近效2026/10/18 C-藥品', '建立日期：2026/10/18'])
    assert.equal(printedDay(text), undefined, text);
});
test('today rolls over at Taipei midnight regardless of the host timezone', () => {
  assert.deepEqual(today(new Date('2026-10-20T15:59:59Z')), day('20261020'));
  assert.deepEqual(today(new Date('2026-10-20T16:00:00Z')), day('20261021'));
});
test('inventory warns at three calendar days inclusive, with no stale warning at two days', () => {
  const now = day('20261021');
  for (const date of ['20261019', '20261020', '20261021', '20261022']) assert.equal(inventoryWarning([{ printed: day(date) }], now), '');
  assert.match(inventoryWarning([{ printed: day('20261018') }], now), /【警語】.*2026\/10\/18.*距今 3 天.*庫存可能已因調劑異動/);
  assert.match(inventoryWarning([{ printed: day('20261017') }], now), /距今 4 天/);
});
test('calendar-day ages work across month, year and leap-day boundaries', () => {
  for (const [printed, now] of [['20260130', '20260202'], ['20261230', '20270102'], ['20240227', '20240301']]) {
    assert.equal(daysBetween(day(printed), day(now)), 3);
    assert.match(inventoryWarning([{ printed: day(printed) }], day(now)), /距今 3 天/);
  }
});
test('the oldest page drives the warning, including later files, zero-row pages and duplicate pages', () => {
  const pages = [
    { printed: day('20261021'), rowCount: 10 },
    { printed: day('20261018'), rowCount: 0, duplicates: 10 },
    { printed: day('20261020'), rowCount: 5 },
  ];
  const warning = inventoryWarning(pages, day('20261021'));
  assert.match(warning, /最早列印於 2026\/10\/18/);
  assert.equal(inventoryWarning([...pages].reverse(), day('20261021')), warning);
});
test('unreadable dates ask for a manual check instead of claiming that the report is fresh or stale', () => {
  const now = day('20261021');
  assert.equal(inventoryWarning([], now), '');
  const unknown = inventoryWarning([{ printed: day('20261021') }, {}], now);
  assert.match(unknown, /【提醒】有 1 頁未能讀取列印日期/);
  assert.ok(!unknown.includes('【警語】'));
  const mixed = inventoryWarning([{ printed: day('20261018') }, {}], now);
  assert.ok(mixed.includes('【警語】') && mixed.includes('【提醒】'));
});
