import { checkPrescriptions, DEPARTMENTS, dxLabel, dxParts, icdDisplay, SUPPLIES, type Layer, type Level, type RxFacts } from './rx-check';
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
 * What the check reads about the patient, under the card's name: 就醫科別, age band, then the diagnoses, each a code and its Chinese
 * name; the stylesheet sets them side by side in columns that keep codes and names aligned. The names wait for the data; the sex
 * goes beside the name itself.
 */
export function renderPatient(box: HTMLDListElement, rx: RxFacts, data?: RxData) {
  const entry = (term: string, value: string | HTMLElement) => {
    const dd = make('dd');
    dd.append(value);
    box.append(make('dt', '', term), dd);
  };
  const dx = make('dl', 'slip-dx');
  for (const code of rx.dx) {
    const parts = data ? dxParts(code, data.icd) : { code: icdDisplay(code), name: '' };
    dx.append(make('dt', '', parts.code), make('dd', '', parts.name));
  }
  box.replaceChildren();
  entry('科別', rx.dept ? `${rx.dept} ${DEPARTMENTS[rx.dept] ?? ''}`.trim() : '科別未知');
  entry('年齡層', rx.age || '年齡不明');
  entry('診斷', rx.dx.length ? dx : '沒有診斷碼');
}

/** One prescription on the 憑單 page as the check reads it: its facts, each drug's name as the card shows it, and its card (第 2 張). */
export interface CheckedPart { rx: RxFacts; names: string[]; label: string }
/**
 * The check under a card on the 憑單 page; the slip itself never prints it. Red and yellow are shown, grey and the drugs a layer
 * explains are folded away. One line each, diagnoses with their Chinese names and other drugs with theirs. The department, age
 * band and diagnoses are listed under the name instead (renderPatient).
 * parts: one prescription, or one patient's prescriptions checked together (checkPrescriptions), each drug then led by its card.
 * names: each drug as the card shows it ('' when the product lookup has none, then its NHI ingredients stand in).
 * aside: where the check is not shown, after the note that some rules await review.
 * Returns the highest level shown, red or yellow, for the cards to take its colour; '' when there is none.
 */
export function renderRxCheck(box: HTMLElement, parts: CheckedPart[], data: RxData, aside = '不印在憑單上'): '紅' | '黃' | '' {
  const many = parts.length > 1;
  const label = (code: string) => dxLabel(code, data.icd);
  const name = (code: string, shown: string) => {
    const info = data.drugs.get(code), text = shown || info?.ingredients || SUPPLIES[code] || code;
    return info ? `${text}（${info.atc}）` : text;
  };
  const drugs = parts.flatMap(part => part.rx.drugs.map(({ code }, i) => ({ code, title: name(code, part.names[i]), label: part.label })));
  // Another drug named in a reason: the first one with that 健保碼; the check puts its card before it when it is on another card.
  const otherDrug = (atc: string, code: string) => drugs.find(drug => drug.code === code)?.title ?? atc;
  const result = checkPrescriptions(parts.map(part => part.rx), data.drugs, data.rules,
    { dx: label, atc: otherDrug, join: '、', part: index => parts[index].label });
  const lines: Line[] = result.notes.map(note => ({ ...note, drug: '' }));
  const explained: Line[] = [];
  const dx = parts.some(part => part.rx.dx.length);
  result.drugs.forEach((drug, i) => {
    const title = many ? `${drugs[i].label} ${drugs[i].title}` : drugs[i].title;
    // Without a diagnosis every unexplained drug is grey; the prescription's one note says so instead. A drug given for another
    // drug (a stomach protector with an antiplatelet) is a grey hint, not just explained: the pharmacist asked to see it.
    if (drug.verdict === '同處方') lines.push({ level: '灰', drug: title, text: drug.reason });
    else if (drug.verdict === '紅' || drug.verdict === '黃' || (drug.verdict === '灰' && dx)) lines.push({ level: drug.verdict, drug: title, text: drug.reason });
    else if (drug.verdict !== '灰') explained.push({ level: drug.verdict, drug: title, text: drug.reason });
    lines.push(...drug.notes.map(note => ({ ...note, drug: title })));
  });
  lines.sort((a, b) => RANK[a.level as Level] - RANK[b.level as Level]);
  const shown = lines.filter(line => line.level !== '灰'), folded = lines.filter(line => line.level === '灰');
  const details = make('details');
  details.append(make('summary', '', `灰色提示 ${folded.length} 則・已解釋 ${explained.length} 個藥`), list([...folded, ...explained]));
  const title = many ? `處方警示：${parts.map(part => part.label).join('、')}是同一病人，以全部的診斷與藥品合併比對（部分規則仍待藥師審核；${aside}）`
    : `處方警示（部分規則仍待藥師審核；${aside}）`;
  box.replaceChildren(make('p', 'rx-title', title), shown.length ? list(shown) : make('p', 'rx-none', '沒有紅色或黃色警示。'), details);
  return shown.some(line => line.level === '紅') ? '紅' : shown.length ? '黃' : '';
}
