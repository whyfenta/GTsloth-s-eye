import { checkPrescription, DEPARTMENTS, dxLabel, dxParts, icdDisplay, type Layer, type Level, type RxFacts } from './rx-check';
import type { RxData } from './rx-data';

interface Line { level: Level | Layer; drug: string; text: string }
const RANK: Record<Level, number> = { 紅: 0, 黃: 1, 灰: 2 };
function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function list(lines: Line[]): HTMLUListElement {
  const ul = make('ul');
  for (const { level, drug, text } of lines) {
    const li = make('li');
    const badge = make('span', 'rx-level', level);
    badge.dataset.level = level;
    li.append(badge, make('span', '', drug ? `${drug}：${text}` : text));
    ul.append(li);
  }
  return ul;
}

/**
 * What the check reads about the patient, under the card's name: 就醫科別, age band, then one diagnosis a row with the codes in one
 * column and the Chinese names in the next. The names wait for the data; the sex goes beside the name itself.
 */
export function renderPatient(table: HTMLTableElement, rx: RxFacts, data?: RxData) {
  const body = make('tbody');
  const row = (label: string, rows: number, ...cells: HTMLTableCellElement[]) => {
    const tr = make('tr');
    if (label) {
      const th = make('th', '', label);
      th.scope = 'row';
      if (rows > 1) th.rowSpan = rows;
      tr.append(th);
    }
    tr.append(...cells);
    body.append(tr);
  };
  const wide = (text: string) => { const td = make('td', '', text); td.colSpan = 2; return td; };
  row('科別', 1, wide(rx.dept ? `${rx.dept} ${DEPARTMENTS[rx.dept] ?? ''}`.trim() : '科別未知'));
  row('年齡層', 1, wide(rx.age || '年齡不明'));
  if (!rx.dx.length) row('診斷', 1, wide('沒有診斷碼'));
  rx.dx.forEach((code, i) => {
    const parts = data ? dxParts(code, data.icd) : { code: icdDisplay(code), name: '' };
    row(i ? '' : '診斷', rx.dx.length, make('td', 'slip-dx-code', parts.code), make('td', '', parts.name));
  });
  table.replaceChildren(body);
}

/**
 * One prescription's check under its card on the 憑單 page; the slip itself never prints it. Red and yellow are shown, grey and
 * the drugs a layer explains are folded away. One line each, diagnoses with their Chinese names and other drugs with theirs.
 * The department, age band and diagnoses are listed under the name instead (renderPatient).
 * names: each drug as the card shows it ('' when the product lookup has none, then its NHI ingredients stand in).
 */
export function renderRxCheck(box: HTMLElement, rx: RxFacts, names: string[], data: RxData) {
  const label = (code: string) => dxLabel(code, data.icd);
  const titles = rx.drugs.map(({ code }, i) => {
    const info = data.drugs.get(code), name = names[i] || info?.ingredients || code;
    return info ? `${name}（${info.atc}）` : name;
  });
  // Another drug named in a reason by its ATC: the first drug on the prescription with that ATC.
  const atcTitle = (atc: string) => titles[rx.drugs.findIndex(({ code }) => data.drugs.get(code)?.atc === atc)] ?? atc;
  const result = checkPrescription(rx, data.drugs, data.rules, { dx: label, atc: atcTitle, join: '、' });
  const lines: Line[] = result.notes.map(note => ({ ...note, drug: '' }));
  const explained: Line[] = [];
  result.drugs.forEach((drug, i) => {
    const title = titles[i];
    // Without a diagnosis every unexplained drug is grey; the prescription's one note says so instead. A drug given for another
    // drug (a stomach protector with an antiplatelet) is a grey hint, not just explained: the pharmacist asked to see it.
    if (drug.verdict === '同處方') lines.push({ level: '灰', drug: title, text: drug.reason });
    else if (drug.verdict === '紅' || drug.verdict === '黃' || (drug.verdict === '灰' && rx.dx.length)) lines.push({ level: drug.verdict, drug: title, text: drug.reason });
    else if (drug.verdict !== '灰') explained.push({ level: drug.verdict, drug: title, text: drug.reason });
    lines.push(...drug.notes.map(note => ({ ...note, drug: title })));
  });
  lines.sort((a, b) => RANK[a.level as Level] - RANK[b.level as Level]);
  const shown = lines.filter(line => line.level !== '灰'), folded = lines.filter(line => line.level === '灰');
  const details = make('details');
  details.append(make('summary', '', `灰色提示 ${folded.length} 則・已解釋 ${explained.length} 個藥`), list([...folded, ...explained]));
  box.replaceChildren(make('p', 'rx-title', '處方警示（部分規則仍待藥師審核；不印在憑單上）'),
    shown.length ? list(shown) : make('p', 'rx-none', '沒有紅色或黃色警示。'), details);
}
