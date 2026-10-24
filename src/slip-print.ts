import './slip.css';
import { asset } from './model';
import { MISSING_ROWS, type SlipData, type Trip } from './slip-model';

// Millimetres on one 210 × 135.7 mm copy, measured from the 會員中台 slip that Chrome prints on A4.
// Text tops are the source's glyph-box tops; .slip-text uses the same 1.32 line height.
const COPY_HEIGHT = 135.7, STORE_COPY_TOP = 156.9, CUT_LINE = 146.3;
const ROW_PITCH = 16.43, THIRD_ROW = 51.58;
const MISSING_TOP = 69.83, MISSING_PITCH = 6.41;
const MISSING_COLUMNS = [[20.54, 24.65, 'center'], [45.19, 62.77, 'left'], [107.96, 20.54, 'center'], [128.5, 20.5, 'left']] as const;
const SVG = 'http://www.w3.org/2000/svg';
type Box = { left: number; top: number; width?: number; height?: number; size: number; align?: 'left' | 'center' | 'right'; kind?: string };

function place(copy: HTMLElement, value: string, box: Box) {
  if (!value) return;
  const span = document.createElement('span');
  span.className = `slip-text ${box.kind ?? ''}`.trim();
  span.textContent = value;
  const style = span.style;
  style.left = `${box.left}mm`; style.top = `${box.top}mm`; style.fontSize = `${box.size}mm`;
  if (box.width) { style.width = `${box.width}mm`; span.classList.add('slip-fit'); }
  if (box.height) { style.height = `${box.height}mm`; span.classList.add('slip-box'); }
  if (box.align) { style.textAlign = box.align; style.justifyContent = { left: 'flex-start', center: 'center', right: 'flex-end' }[box.align]; }
  copy.append(span);
}
function rect(svg: SVGSVGElement, [x, y, width, height]: number[], fill: string) {
  const shape = document.createElementNS(SVG, 'rect');
  for (const [name, value] of Object.entries({ x, y, width, height, fill })) shape.setAttribute(name, String(value));
  svg.append(shape);
}
function canvas(width: number, height: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', `${width}mm`); svg.setAttribute('height', `${height}mm`);
  return svg;
}
const two = (value: string) => value.padStart(2, '0');
function dates(copy: HTMLElement, value: string, left: [number, number, number], top: number, size: number, kind = 'slip-num') {
  const [year, month, day] = value.split('-');
  place(copy, year, { left: left[0], top, size, kind });
  place(copy, two(month), { left: left[1], top, size, kind });
  place(copy, two(day), { left: left[2], top, size, kind });
}
function trip(copy: HTMLElement, value: Trip | undefined, top: number) {
  if (!value) return;
  const [, startMonth, startDay] = value.start.split('-'), [, endMonth, endDay] = value.end.split('-');
  for (const [text, left] of [[startMonth, 51.31], [startDay, 65.32], [endMonth, 82.57], [endDay, 94.88]] as const) place(copy, two(text), { left, top, size: 5.19, kind: 'slip-num slip-blue' });
  place(copy, `x${value.prescriptions}`, { left: 102.02, top: top + 5.15, size: 4.67, kind: 'slip-num' });
}

function copyOf(data: SlipData, store: boolean, form: string): HTMLElement {
  const copy = document.createElement('div');
  copy.className = 'slip-copy';
  copy.style.top = `${store ? STORE_COPY_TOP : 0}mm`;
  const image = document.createElement('img');
  image.src = form; image.alt = '';
  // White covers hide the sample 單號 "AB" (left blank) and the form's 聯別 footer, as 會員中台 does; SVG fills print without background graphics.
  const covers = canvas(210, COPY_HEIGHT);
  rect(covers, [23.07, 15.3, 25.67, 3.63], '#fff');
  rect(covers, [13.74, 127.56, 105, 4.15], '#fff');
  if (store) rect(covers, [77.78, 4.15, 56.52, 8.3], '#fff');
  if (data.sms) rect(covers, [151.9, 54.96, 4.41, 4.41], '#000');
  if (data.call) rect(covers, [175.9, 54.96, 4.41, 4.41], '#000');
  copy.append(image, covers);
  if (store) place(copy, '門市存查', { left: 77.78, top: 4.15, width: 56.52, height: 8.3, size: 7.26, align: 'center', kind: 'slip-title' });
  dates(copy, data.openDate, [73.9, 86.1, 96.8], 15.34, 3.11);
  place(copy, data.names, { left: 16, top: 20.92, width: 54.06, size: 5.7, align: 'right', kind: 'slip-blue' });
  place(copy, data.hospitals, { left: 107.2, top: 20.6, width: 41, height: 8.3, size: 3.63, align: 'center', kind: 'slip-wrap' });
  dates(copy, data.validUntil, [154.14, 171.79, 185.63], 24.46, 3.63);
  place(copy, data.phone, { left: 150.3, top: 39.33, width: 44.56, size: 4.15, align: 'center', kind: 'slip-num slip-blue' });
  trip(copy, data.second, THIRD_ROW - ROW_PITCH);
  trip(copy, data.third, THIRD_ROW);
  place(copy, data.note, { left: 151.5, top: 65, width: 44.5, height: 23.5, size: 3.2, kind: 'slip-wrap slip-top' });
  place(copy, data.staff, { left: 167.5, top: 89.8, width: 28, size: 3.4 });
  if (data.missing.length) place(copy, String(data.missing.length), { left: 14.4, top: 74.76, width: 5, size: 3.4, align: 'center', kind: 'slip-num' });
  data.missing.slice(0, MISSING_ROWS).forEach((item, row) => {
    const top = MISSING_TOP + row * MISSING_PITCH;
    [item.code, item.name, item.quantity, item.note].forEach((value, column) => {
      const [left, width, align] = MISSING_COLUMNS[column];
      place(copy, value, { left: left + .8, top, width: width - 1.6, height: MISSING_PITCH, size: 3, align });
    });
  });
  if (store) place(copy, data.footer, { left: 13.65, top: 127.67, width: 104, size: 3.63, kind: 'slip-num' });
  return copy;
}

/** Shrinks any overfilled field until it fits; the sheet is laid out off screen, so it can be measured. */
function fit(sheet: HTMLElement) {
  for (const span of sheet.querySelectorAll<HTMLElement>('.slip-fit')) {
    let size = parseFloat(span.style.fontSize);
    while (size > 1.8 && (span.scrollWidth > span.clientWidth + 1 || span.scrollHeight > span.clientHeight + 1)) {
      size -= .15;
      span.style.fontSize = `${size.toFixed(2)}mm`;
    }
  }
}

/** Customer copy above, 門市存查 below. The patient copy carries no ID number, not even hidden text. */
export async function printSlip(sheet: HTMLElement, data: SlipData): Promise<void> {
  const cut = canvas(210, 297);
  rect(cut, [0, CUT_LINE, 210, .26], '#999');
  rect(cut, [0, CUT_LINE + .3, 210, STORE_COPY_TOP - CUT_LINE - 1.6], '#ffd5ea');
  const form = asset('forms/rx-slip.jpg');
  sheet.replaceChildren(cut, copyOf(data, false, form), copyOf(data, true, form));
  try { await Promise.all([...sheet.querySelectorAll('img')].map(image => image.decode())); }
  catch { sheet.replaceChildren(); throw new Error('憑單底圖載入失敗，請確認網路後再列印。'); }
  fit(sheet);
  const done = () => { document.body.classList.remove('print-slip'); sheet.replaceChildren(); };
  window.addEventListener('afterprint', done, { once: true });
  document.body.classList.add('print-slip');
  window.print();
}
