import { checkPrescription, DEPARTMENTS, dxLabel, type Layer, type Level, type RxFacts } from './rx-check';
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
 * One prescription's check under its card on the 憑單 page; the slip itself never prints it. Red and yellow are shown, grey and
 * the drugs a layer explains are folded away. One line each, diagnoses with their Chinese names. names: each drug as the card
 * shows it ('' when the product lookup has none, then its NHI ingredients stand in).
 */
export function renderRxCheck(box: HTMLElement, rx: RxFacts, names: string[], data: RxData) {
  const label = (code: string) => dxLabel(code, data.icd);
  const result = checkPrescription(rx, data.drugs, data.rules, { dx: label, join: '、' });
  const lines: Line[] = result.notes.map(note => ({ ...note, drug: '' }));
  const explained: Line[] = [];
  result.drugs.forEach((drug, i) => {
    const name = names[i] || drug.info?.ingredients || drug.code;
    const title = drug.info ? `${name}（${drug.info.atc}）` : name;
    // Without a diagnosis every unexplained drug is grey; the prescription's one note says so instead.
    if (drug.verdict === '紅' || drug.verdict === '黃' || (drug.verdict === '灰' && rx.dx.length)) lines.push({ level: drug.verdict, drug: title, text: drug.reason });
    else if (drug.verdict !== '灰') explained.push({ level: drug.verdict, drug: title, text: drug.reason });
    lines.push(...drug.notes.map(note => ({ ...note, drug: title })));
  });
  lines.sort((a, b) => RANK[a.level as Level] - RANK[b.level as Level]);
  const shown = lines.filter(line => line.level !== '灰'), folded = lines.filter(line => line.level === '灰');
  const dept = rx.dept ? `${rx.dept} ${DEPARTMENTS[rx.dept] ?? ''}`.trim() : '科別未知';
  const dx = rx.dx.length ? rx.dx.map(label).join('、') : '沒有診斷碼';
  const details = make('details');
  details.append(make('summary', '', `灰色提示 ${folded.length} 則・已解釋 ${explained.length} 個藥`), list([...folded, ...explained]));
  box.replaceChildren(make('p', 'rx-title', '處方警示（規則草稿，待藥師審核；不印在憑單上）'), make('p', 'hint', `${dept} · ${rx.age || '年齡不明'} · 診斷：${dx}`),
    shown.length ? list(shown) : make('p', 'rx-none', '沒有紅色或黃色警示。'), details);
}
