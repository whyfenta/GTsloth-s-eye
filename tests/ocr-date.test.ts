import test from 'node:test';
import assert from 'node:assert/strict';
import { PSM } from 'tesseract.js';
import { OCREngine } from '../src/ocr';
import type { Reading } from '../src/parser';

const canvas = { width: 1000, height: 700 } as HTMLCanvasElement;
const reading = (text: string): Reading => ({ text, words: [], lines: [], confidence: 100 });
test('OCR dates use the upright footer crop when the header has no printed date', async () => {
  const engine = new OCREngine(() => {}); let calls = 0;
  engine.recognize = async (image, type, psm, rectangle) => {
    calls++; assert.equal(image, canvas); assert.equal(type, 'chinese'); assert.equal(psm, PSM.SPARSE_TEXT);
    assert.deepEqual(rectangle, { x: 0, y: 595, width: 1000, height: 105 });
    return reading('列印時間：2026/10/18 09:00:00');
  };
  assert.deepEqual(await engine.readPrintedDay(canvas, '庫存簡表'), { y: 2026, m: 10, d: 18 });
  assert.equal(calls, 1);
});
test('OCR dates already read in the header need no additional OCR pass', async () => {
  const engine = new OCREngine(() => {});
  engine.recognize = async () => { assert.fail('unnecessary footer OCR'); };
  assert.deepEqual(await engine.readPrintedDay(canvas, '列印時間：2026/10/18'), { y: 2026, m: 10, d: 18 });
});
test('missing footer dates or metadata OCR failures stay unknown; cancellation still propagates', async () => {
  const engine = new OCREngine(() => {});
  engine.recognize = async () => reading('頁次 1 of 2');
  assert.equal(await engine.readPrintedDay(canvas, ''), undefined);
  engine.recognize = async () => { throw new Error('date crop could not be read'); };
  assert.equal(await engine.readPrintedDay(canvas, ''), undefined);
  engine.terminated = true;
  await assert.rejects(engine.readPrintedDay(canvas, ''), /date crop could not be read/);
});
