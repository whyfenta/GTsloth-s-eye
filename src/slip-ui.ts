import { addDays, taiwanToday, type DateRange } from './arithmetic-model';
import { loadRoster, ROSTER_SOURCE, unknownInstitution } from './institutions';
import { multiQRNote, printsMultiQR } from './multi-qr';
import type { DrugsQR, SlipQR } from './prescription-qr';
import { loadProducts } from './products';
import type { RxFacts } from './rx-check';
import { rxCheckOn } from './rx-check-config';
import { renderPatient, renderRxCheck } from './rx-check-ui';
import { loadRxData, type RxData } from './rx-data';
import { failureLine } from './prescription-sample';
import { FailureLog, sampleOf, sampleRecords, sendSamples, withDrugs, type PendingSample } from './rx-sample';
import { SAMPLE_ENDPOINT, samplesOn } from './sample-config';
import { buildSlip, contactKind, patientGroups, planSlip, prescriptionAhead, MISSING_ROWS, type ContactKind, type MissingItem, type Person, type Product, type SlipEntry, type SlipPlan, type Trip } from './slip-model';
import { printSlip } from './slip-print';

declare const __APP_VERSION__: string;
// Every scanned prescription joins the slip; identifying fields live only in these objects and the inputs below.
// products: the 六碼 the product lookup gives the 健保碼; product: the one on the slip, chosen when there are several.
interface Drug { code: string; total: string; missing: boolean; name: string; quantity: string; note: string; products: Product[]; product?: Product }
// more: the follow-up QRs of drugs only, so a rescan of one is not added twice. qrs: how many QR codes the card was read from. sample: the de-identified line sent when the
// slip is printed (only with samples on), and sent once that request has gone out. patient: the 科別, age band and diagnoses under the name.
// person: the ID number, name and birth date as scanned, which tell the prescriptions of one patient (the name field can be edited).
interface Item extends SlipEntry { key: string; institution: string; person: Person; drugs: Drug[]; firstDrugs: number; more: string[]; qrs: number; rx: RxFacts; element: HTMLLIElement; heading: HTMLElement; state: HTMLElement; hospitalNote: HTMLElement;
  patient: HTMLDListElement; drugList: HTMLFieldSetElement; check: HTMLElement; counts: HTMLInputElement[]; visits: HTMLInputElement[]; sample?: PendingSample; sent: boolean }
type Row = 'second' | 'third';
interface TripRow { row: Row; element: HTMLElement; start: HTMLInputElement; end: HTMLInputElement; count: HTMLElement; reset: HTMLButtonElement; hint: HTMLElement }
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const panel = element('slip-panel');
const body = element('slip-body');
const empty = element('slip-empty');
const list = element<HTMLOListElement>('slip-items');
const preview = element('slip-plan');
const status = element('slip-status');
const sheet = element('slip-sheet');
const phone = element<HTMLInputElement>('slip-phone');
const staff = element<HTMLInputElement>('slip-staff');
const sms = element<HTMLInputElement>('slip-sms');
const call = element<HTMLInputElement>('slip-call');
const note = element<HTMLTextAreaElement>('slip-note');
const tripBox = element('slip-trips');
const scanField = element<HTMLInputElement>('prescription-date');
/** The scan field's message (已加入第 n 張…), which a removed or cleared card makes wrong. */
const scanStatus = element('qr-status');
let items: Item[] = [];
/** 健保碼 → 六碼, loaded on the first scan. */
let catalog: Map<string, Product[]> | undefined;
/** 處方警示: off unless switched on (src/rx-check-config.ts); its rules and lookups load on the first scan. */
const rxOn = rxCheckOn(location.search);
let rxData: RxData | undefined;
/** Why the rule data did not load; the next scan tries again. */
let rxError = '';
/** 處方樣本: on whenever src/sample-config.ts has an address (?samples=0 turns it off). The check summary needs the rule data too. */
const samples = samplesOn(location.search);
/** Failure lines of scans the slip turned down, sent a few seconds after the scan, or with a slip printed before then. */
const rejected = new FailureLog(failed => sendSamples(sampleRecords([], failed, undefined, __APP_VERSION__, new Date().toISOString()), SAMPLE_ENDPOINT));
element('slip-sample-note').hidden = !samples;
/** The calculated trips, and dates agreed with the patient in their place; base is the window they replaced. */
let plan: SlipPlan | undefined;
let agreed: Partial<Record<Row, { base: Trip; range: DateRange }>> = {};
/** A scanner may end a code with two Enters; the second must not confirm the default refill count. */
let scannedAt = 0;
/** After printing, the next scan starts a new slip so two patients are never merged by accident. */
let printed = false;
/** The kind of number in 聯絡人與電話 the notification ticks were last set for; a tick changed by hand stays until the kind changes. */
let contact: ContactKind = '';

const fullDate = (value: string) => value.replaceAll('-', '/');
const monthDay = (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
const sameTrip = (a: Trip, b: Trip) => a.start === b.start && a.end === b.end && a.prescriptions === b.prescriptions;
/** The date in 處方已於…失效 is set bold and larger: it is why the prescription cannot be dispensed. */
const withExpiry = (text: string) => text.split(/(\d+\/\d{2}\/\d{2})(?=失效)/).map((part, index) => index % 2 ? make('strong', 'slip-expiry', part) : part);
function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = make('label', '', text);
  label.append(control);
  return label;
}
function textInput(value: string, placeholder = '', onInput?: (value: string) => void): HTMLInputElement {
  const input = make('input');
  input.type = 'text'; input.value = value; input.placeholder = placeholder; input.autocomplete = 'off';
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  return input;
}
let serial = 0;
/** One row of radio buttons: the arrow keys move the choice (the browser's own radio behaviour), Enter confirms it. */
function segmented(caption: string, options: [number, string][], onChange: (value: number) => void, onEnter: () => void) {
  const group = make('div', 'slip-choice');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', caption);
  const name = `slip-choice-${++serial}`;
  const radios = options.map(([value, text]) => {
    const radio = make('input');
    radio.type = 'radio'; radio.name = name; radio.value = String(value);
    // 'input' runs before the panel re-renders on the same event; on 'change' the re-render would undo the choice.
    radio.addEventListener('input', () => { if (radio.checked) onChange(value); });
    radio.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); onEnter(); }
      // A scan started before Enter came back here (a prescription's second QR right after its first) goes to the scan field.
      else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        scanField.focus();
        scanField.value += event.key;
        scanField.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const option = make('label');
    option.append(radio, make('span', '', text));
    group.append(option);
    return radio;
  });
  const field = make('div', 'slip-field');
  field.append(make('span', 'slip-field-label', caption), group);
  return { field, radios };
}
const focusChoice = (radios: HTMLInputElement[]) => (radios.find(radio => radio.checked && !radio.disabled) ?? radios[0]).focus();

function describe(item: Item) {
  // Until a visit is picked the row shows the one inferred from today; a prescription of two has no third visit.
  if (item.count === 2 && item.visit === 3) item.visit = undefined;
  let inferred: number | undefined;
  try { inferred = prescriptionAhead({ ...item, visit: undefined }, taiwanToday()).visit; } catch { /* Shown below. */ }
  item.counts.forEach(radio => { radio.checked = Number(radio.value) === item.count; });
  item.visits.forEach((radio, index) => {
    const visit = index + 1;
    radio.disabled = visit > (item.count ?? 3);
    radio.checked = visit === (item.visit ?? inferred);
    radio.nextElementSibling!.replaceChildren(`第 ${visit} 次`, ...visit === inferred ? [make('small', '', '推算')] : []);
  });
  item.state.dataset.state = '';
  if (!item.count) { item.state.textContent = '請選擇可調劑次數；QR 不含此資料。'; return; }
  try {
    const ahead = prescriptionAhead(item, taiwanToday());
    item.state.dataset.state = ahead.result.state;
    const next = ahead.windows.map(window => `第 ${window.visit} 次 ${monthDay(window.range.start)}～${monthDay(window.range.end)}`).join('、');
    // A late last visit's corrected window is the return visit, which the slip leaves out.
    const message = ahead.result.state === 'late' && !next ? '本次領藥延遲。' : ahead.result.message;
    item.state.replaceChildren(...withExpiry(`${item.visit ? '' : '依今日判斷'}第 ${ahead.visit} 次：${message}${next ? `接下來：${next}。` : ahead.result.state === 'invalid' ? '' : '已無下次領藥，下次請回診。'}`));
  } catch (error) { item.state.textContent = (error as Error).message; }
}
function missingItems(): MissingItem[] {
  // An identified drug prints its 六碼; the 健保碼 stays for one the map does not have.
  const fromQR = items.flatMap((item, index) => item.drugs.filter(drug => drug.missing).map(({ code, products, product, name, quantity, note }) => {
    if (!product && products.length) throw new Error(`第 ${index + 1} 張尚差藥品 ${products[0].name}（健保碼 ${code}）對到 ${products.length} 個六碼，請選擇缺的是哪一個。`);
    return { code: product?.sku ?? code, name, quantity, note };
  }));
  const typed = [...others.querySelectorAll<HTMLElement>('.slip-other')].map(row => {
    const [code, name, quantity, remark] = [...row.querySelectorAll('input')].map(input => input.value.trim());
    return { code, name, quantity, note: remark };
  }).filter(row => row.code || row.name);
  return [...fromQR, ...typed];
}
function slipData() {
  return buildSlip(items, { phone: phone.value.trim(), sms: sms.checked, call: call.checked, note: note.value.trim(), staff: staff.value.trim(), missing: missingItems(),
    trips: { second: agreed.second?.range, third: agreed.third?.range } }, taiwanToday());
}

function setAgreed(row: Row, side: keyof DateRange, value: string) {
  const computed = plan?.[row];
  if (!computed || !value) return; // A date being typed is empty until it is complete.
  const range = { ...(agreed[row]?.range ?? { start: computed.start, end: computed.end }), [side]: value };
  if (range.start === computed.start && range.end === computed.end) delete agreed[row];
  else agreed[row] = { base: computed, range };
}
/** Up / → move the date a day later, down / ← a day earlier; Enter goes to the next date, then to the phone number. */
function dateInput(row: Row, side: keyof DateRange, label: string): HTMLInputElement {
  const input = make('input');
  input.type = 'date';
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => setAgreed(row, side, input.value));
  input.addEventListener('keydown', event => {
    const step = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 } as Record<string, number>)[event.key];
    if (step && input.value) {
      event.preventDefault();
      const next = addDays(input.value, step);
      if (next < input.min || next > input.max) return;
      input.value = next;
      setAgreed(row, side, next);
      update();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const fields = tripRows.filter(trip => !trip.element.hidden).flatMap(trip => [trip.start, trip.end]);
      (fields[fields.indexOf(input) + 1] ?? phone).focus();
    }
  });
  return input;
}
const tripRows: TripRow[] = ([['second', '第二次'], ['third', '第三次']] as const).map(([row, label]) => {
  const element = make('div', 'slip-trip');
  const start = dateInput(row, 'start', `${label}預計領藥日起日`), end = dateInput(row, 'end', `${label}預計領藥日訖日`);
  const reset = make('button', '', '還原計算值');
  reset.type = 'button';
  reset.addEventListener('click', () => { delete agreed[row]; update(); });
  const count = make('span', 'slip-trip-count'), hint = make('span', 'hint');
  element.append(make('span', 'slip-trip-label', label), start, make('span', '', '～'), end, count, reset, hint);
  tripBox.append(element);
  return { row, element, start, end, count, reset, hint };
});
/** Dates agreed for a window that has since been recalculated (another scan, a changed count) no longer apply. */
function showTrips() {
  const today = taiwanToday();
  for (const { row, element, start, end, count, reset, hint } of tripRows) {
    const computed = plan?.[row];
    const kept = agreed[row];
    if (kept && !(computed && sameTrip(kept.base, computed))) {
      delete agreed[row];
      status.textContent = '處方內容改變，預計領藥日已改回新的計算值。';
    }
    element.hidden = !computed;
    if (!plan || !computed) continue;
    const range = agreed[row]?.range ?? computed;
    for (const [input, value] of [[start, range.start], [end, range.end]] as const) {
      input.min = computed.start < today ? computed.start : today;
      input.max = plan.validUntil;
      if (input.value !== value && !(document.activeElement === input && !input.value)) input.value = value;
    }
    count.textContent = `x${computed.prescriptions}`;
    reset.hidden = !agreed[row];
    hint.textContent = agreed[row] ? `計算值 ${monthDay(computed.start)}～${monthDay(computed.end)}` : '';
  }
  tripBox.hidden = tripRows.every(trip => trip.element.hidden);
}
/** The preview shows what will print, or the first reason it cannot. */
function update() {
  items.forEach((item, index) => { item.heading.textContent = `第 ${index + 1} 張 · ${item.name || '（無姓名）'}`; describe(item); });
  body.hidden = !items.length;
  empty.hidden = !!items.length;
  preview.replaceChildren();
  try { plan = items.length ? planSlip(items, taiwanToday()) : undefined; } catch { plan = undefined; } // The preview below says why.
  showTrips();
  if (!items.length) return;
  try {
    const data = slipData();
    const lines = [
      !data.second && !data.third ? '沒有下次領藥區間，預計領藥日留白。' : '',
      `領藥最終有效時間 ${fullDate(data.validUntil)}`,
      data.names.includes('、') ? `合併病人：${data.names}` : '',
      ...data.notes,
    ].filter(Boolean);
    preview.append(...lines.map(line => make('p', '', line)));
  } catch (error) {
    const line = make('p', 'error');
    line.append(...withExpiry((error as Error).message));
    preview.append(line);
  }
}

/** A name filled in from the map follows the chosen 六碼; a typed name stays. */
function choose(drug: Drug, product: Product | undefined) {
  if (!drug.name || drug.name === drug.product?.name) drug.name = product?.name ?? '';
  drug.product = product;
}
/** Looks the 健保碼 up in the loaded map. A 健保碼 with several 六碼 keeps an earlier choice, or waits for one. */
function identify(drug: Drug) {
  drug.products = catalog?.get(drug.code.toUpperCase()) ?? [];
  choose(drug, drug.products.length === 1 ? drug.products[0] : drug.products.find(product => product.sku === drug.product?.sku));
}
/** The 六碼 is set in bold so it stands apart from the name; a 健保碼 left unmatched stays plain. */
function drugText(text: HTMLElement, drug: Drug) {
  const total = `（總量 ${drug.total}）`;
  const replaced = (product: Product) => product.replaced ? `（原六碼 ${product.replaced.sku} 已改用，新健保碼 ${product.replaced.code}）` : '';
  if (drug.product) return text.replaceChildren(make('strong', 'slip-sku', drug.product.sku), `${drug.product.name}${total}${replaced(drug.product)}`);
  if (!drug.products.length) return text.replaceChildren(`${drug.code}${total}${catalog ? ' · 對照檔查無此健保碼' : ''}`);
  text.replaceChildren(make('strong', 'slip-sku', drug.products.map(product => product.sku).join('／')),
    `${[...new Set(drug.products.map(product => product.name))].join('／')}${total}${[...new Set(drug.products.map(replaced))].join('')}`);
}
function drugRow(drug: Drug): HTMLElement {
  const row = make('div', 'slip-drug');
  const box = make('input');
  box.type = 'checkbox';
  box.checked = drug.missing;
  const detail = make('div', 'slip-drug-detail');
  detail.hidden = !drug.missing;
  const text = make('span');
  drugText(text, drug);
  const name = textInput(drug.name, '品名', value => { drug.name = value.trim(); });
  if (drug.products.length > 1) {
    const select = make('select');
    select.setAttribute('aria-label', '缺的是哪一個六碼');
    select.add(new Option(`請選擇六碼（此健保碼對到 ${drug.products.length} 個）`, ''));
    for (const product of drug.products) select.add(new Option(`${product.sku} ${product.full}${product.replaced ? `（改用，原 ${product.replaced.sku}）` : ''}`, product.sku));
    select.value = drug.product?.sku ?? '';
    select.addEventListener('change', () => {
      choose(drug, drug.products.find(product => product.sku === select.value));
      name.value = drug.name;
      drugText(text, drug);
    });
    detail.append(select);
  }
  detail.append(name,
    textInput(drug.quantity, '缺藥數量', value => { drug.quantity = value.trim(); }),
    textInput(drug.note, '備註', value => { drug.note = value.trim(); }));
  box.addEventListener('change', () => { drug.missing = box.checked; detail.hidden = !box.checked; });
  const label = make('label', 'slip-check');
  if (drug.products.length) label.title = `健保碼 ${drug.code}`;
  label.append(box, text);
  row.append(label, detail);
  return row;
}
/**
 * 其他尚差品項 (self-paid items and the like) are the slip's, not one prescription's: their typed rows end the drug list of the
 * prescription scanned last, and move along, as typed, when another is scanned or that one is removed.
 */
const extras = make('div', 'slip-extras');
const others = make('div');
const addOther = make('button', '', '＋其他品項');
addOther.type = 'button';
extras.append(make('p', 'slip-extras-label', '其他尚差品項（選填，如自費品項）'), others, addOther);
const placeExtras = () => items.at(-1)?.drugList.append(extras);
function listDrugs(item: Item) {
  item.drugList.replaceChildren(make('legend', '', `藥品清單（如有缺藥可勾選${item.more.length ? `；含藥品 QR 加入的 ${item.drugs.length - item.firstDrugs} 個藥` : ''}）`),
    ...printsMultiQR(item.institution) ? [make('p', 'slip-multi-qr', multiQRNote(item.qrs))] : [], ...item.drugs.map(drugRow));
  if (item === items.at(-1)) item.drugList.append(extras);
}
function fillItem(item: Item) {
  const li = item.element;
  const head = make('div', 'slip-item-head');
  const remove = make('button', '', '移除本單');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    items = items.filter(other => other !== item);
    li.remove();
    placeExtras();
    status.textContent = scanStatus.textContent = '';
    showChecks();
    update();
  });
  head.append(item.heading, make('span', 'hint', `處方 ${fullDate(item.date)} · ${item.days} 天`), remove);
  const fields = make('div', 'slip-item-fields');
  const hospital = textInput(item.hospital, '查詢醫院名冊中…', value => { item.hospital = value; });
  hospital.dataset.role = 'hospital';
  // Scan → refill count (3 by default) → visit (inferred by default) → back to the scan field for the next prescription.
  const count = segmented('可調劑次數', [[2, '2 次'], [3, '3 次']], value => { item.count = value; },
    () => { if (performance.now() - scannedAt > 300) focusChoice(item.visits); });
  const visit = segmented('本次第幾次', [[1, '第 1 次'], [2, '第 2 次'], [3, '第 3 次']], value => { item.visit = value; }, () => scanField.focus());
  item.counts = count.radios; item.visits = visit.radios;
  // The sex from the ID number's second character follows the name inside its box; it is not part of the name on the slip.
  const name = make('span', 'slip-name');
  name.append(textInput(item.name, '', value => { item.name = value.trim(); }));
  if (item.rx.sex) {
    const sex = make('span', 'slip-sex', item.rx.sex);
    sex.title = `${item.rx.sex === 'M' ? '男' : '女'}（依身分證字號第 2 碼）`;
    name.append(sex);
  }
  fields.append(labelled('姓名', name), labelled('醫院名稱', hospital), count.field, visit.field);
  listDrugs(item);
  li.append(head, fields, item.patient, item.hospitalNote, item.state, item.drugList, item.check);
}
/** The cards' drug names for the check: the product lookup's once it has loaded ('' until then, and the NHI ingredients stand in). */
const drugNames = (item: Item) => item.drugs.map(drug => drug.product?.name ?? [...new Set(drug.products.map(product => product.name))].join('／'));
/** The cards scanned for the same patient as this one, itself included, as their card numbers. */
function patientOf(item: Item): number[] {
  const index = items.indexOf(item);
  return patientGroups(items.map(other => other.person)).find(group => group.includes(index)) ?? [index];
}
/**
 * The cards' 處方警示, never on the slip; drug names follow the product lookup once it has loaded, diagnosis names the rule data.
 * One patient's prescriptions (several departments handed in together) are checked as one, every diagnosis against every drug,
 * under the last of their cards, where the next scan lands; the earlier cards say so. Run again whenever a card comes or goes.
 */
function showChecks() {
  if (!rxOn) return;
  for (const item of items) renderPatient(item.patient, item.rx, rxData);
  if (!rxData) {
    for (const item of items) {
      item.check.replaceChildren(rxError ? make('p', 'error', rxError) : make('p', 'hint', '處方警示資料載入中…'));
      delete item.element.dataset.rxLevel;
    }
    return;
  }
  const data = rxData;
  for (const group of patientGroups(items.map(item => item.person))) {
    const cards = group.map(index => `第 ${index + 1} 張`), last = items[group.at(-1)!];
    const level = renderRxCheck(last.check, group.map(index => ({ rx: items[index].rx, names: drugNames(items[index]), label: `第 ${index + 1} 張` })), data);
    // Every card of the patient takes the colour of the highest red or yellow warning, a pale one the eye catches while typing.
    for (const index of group) {
      if (level) items[index].element.dataset.rxLevel = level;
      else delete items[index].element.dataset.rxLevel;
    }
    for (const index of group.slice(0, -1)) {
      items[index].check.replaceChildren(make('p', 'rx-title', `處方警示：${cards.join('、')}是同一病人，診斷與藥品合併比對，結果在${cards.at(-1)}下方。`));
    }
  }
}
/** The rule data on the first scan with the check or samples on; a failed load is tried again on the next scan. */
function loadChecks() {
  if (!(rxOn || samples) || rxData) return;
  rxError = '';
  loadRxData().then(loaded => { rxData = loaded; showChecks(); })
    .catch((error: Error) => { if (rxData) return; rxError = error.message; showChecks(); });
}
function lookup(item: Item) {
  const input = item.element.querySelector<HTMLInputElement>('[data-role=hospital]')!;
  loadRoster().then(roster => {
    input.placeholder = '';
    if (!items.includes(item) || input.value.trim()) return; // Removed, or typed while loading.
    const name = roster.names[item.institution];
    if (name) { item.hospital = input.value = name; update(); return; }
    const link = make('a', '', '政府資料開放平臺「健保特約醫療院所名冊」');
    link.href = ROSTER_SOURCE; link.target = '_blank'; link.rel = 'noopener';
    item.hospitalNote.replaceChildren(unknownInstitution(item.institution, roster), ' 下載處：', link);
  }).catch((error: Error) => { input.placeholder = ''; item.hospitalNote.textContent = error.message; });
}

function otherRow(): HTMLElement {
  const row = make('div', 'slip-other');
  const remove = make('button', '', '移除');
  remove.type = 'button';
  remove.addEventListener('click', () => { row.remove(); update(); });
  row.append(textInput('', '品項編號'), textInput('', '品名（如自費品項）'), textInput('', '數量'), textInput('', '備註'), remove);
  return row;
}
addOther.addEventListener('click', () => {
  const used = items.reduce((sum, item) => sum + item.drugs.filter(drug => drug.missing).length, 0) + others.querySelectorAll('.slip-other').length;
  if (used >= MISSING_ROWS) {
    status.textContent = `憑單的尚差欄只有 ${MISSING_ROWS} 列，其餘請寫在備註。`;
    return;
  }
  others.append(otherRow());
});

export function clearSlip() {
  items = [];
  printed = false;
  list.replaceChildren();
  others.replaceChildren(otherRow());
  agreed = {};
  for (const input of [phone, note]) input.value = '';
  sms.checked = call.checked = false;
  contact = '';
  status.textContent = '';
  update(); // 承辦人員 stays for the next patient; it is not patient data.
}
/** A scan the slip turned down is kept as the collector's failure line, its reason and field count only. */
export function rejectScan(scanned: string, error: unknown) {
  if (samples && scanned.includes(';')) void rejected.add(scanned, failureLine(scanned, error));
}
/** What a scan did: the message for the scan field and, when the slip took it, its card and the control to type into next. */
export interface Scanned { message: string; card?: HTMLElement; focus?: HTMLElement }
/**
 * Adds a scanned prescription. scanned: the QR text, read here for the de-identified sample only and not kept.
 * camera: read by the phone camera, where the card is tapped rather than keyed through. qrs: how many linked QR codes (Structured
 * Append) the text was joined from, counted in the sample as a prescription with a second QR.
 */
export function addPrescription(qr: SlipQR, scanned = '', camera = false, qrs = 1): Scanned {
  const restarted = printed;
  if (printed) clearSlip();
  status.textContent = '';
  const key = [qr.institution, qr.idNumber, qr.name, qr.date, qr.days, ...qr.drugs.map(drug => drug.code)].join('|');
  const existing = items.findIndex(item => item.key === key);
  if (existing >= 0) return { message: `這張處方已在憑單第 ${existing + 1} 張，不重複加入。` };
  // The owed quantity is whatever the store is short of, so it is typed, not taken from the QR total.
  const item: Item = { key, institution: qr.institution, person: { idNumber: qr.idNumber, name: qr.name, birth: qr.birth }, date: qr.date, days: qr.days, count: 3, name: qr.name, idNumber: qr.idNumber, birth: qr.birth, hospital: '',
    drugs: qr.drugs.map(drug => ({ ...drug, missing: false, name: '', quantity: '', note: '', products: [] })), firstDrugs: qr.drugs.length, more: [], qrs, rx: qr.rx,
    element: make('li', 'slip-item'), heading: make('strong'), state: make('p', 'slip-item-state'), hospitalNote: make('p', 'hint slip-hospital-note'),
    patient: make('dl', 'slip-patient'), drugList: make('fieldset', 'slip-drugs'), check: make('section', 'slip-rx-check'), counts: [], visits: [], sent: false,
    ...(samples && scanned ? { sample: sampleOf(scanned, qrs) } : {}) };
  item.check.hidden = item.patient.hidden = !rxOn;
  item.drugs.forEach(identify);
  fillItem(item);
  items.push(item);
  list.append(item.element);
  placeExtras();
  lookup(item);
  loadChecks();
  showChecks();
  if (!catalog) loadProducts().then(loaded => {
    if (catalog) return;
    catalog = loaded.index;
    for (const other of items) { other.drugs.forEach(identify); listDrugs(other); }
    showChecks();
    update();
  }).catch((error: Error) => { status.textContent = error.message; });
  update();
  scannedAt = performance.now();
  const patient = patientOf(item).slice(0, -1).map(index => `第 ${index + 1} 張`);
  return { message: `${restarted ? '上一張憑單已列印，已開始新的憑單；' : ''}已加入第 ${items.length} 張${qr.name ? `（${qr.name}）` : ''}。`
    + (rxOn && patient.length ? `與${patient.join('、')}是同一病人，處方警示合併比對全部的診斷與藥品。` : '') + '可調劑次數預設 3 次、本次第幾次依日期推算：'
    + (camera ? '請在卡片上核對；處方有第 2 個 QR 時，再按相機鈕掃描。' : '以方向鍵選擇，Enter 確認後回到掃碼欄。')
    + (printsMultiQR(qr.institution) ? '這家院所藥品多時可能有 2 個以上的 QR，請核對卡片上的藥品清單是否完整。' : '')
    + (!qr.idNumber ? '讀不到身分證字號，門市存查聯不印此人的身分證。'
      : `${qr.idNumber}.${qr.birth}`.includes('*') ? '這家院所的 QR 遮蔽了部分身分證字號或生日（*），門市存查聯照 QR 所示列印。' : ''),
    card: item.element, focus: item.counts.find(radio => radio.checked) };
}

/** A follow-up QR has no patient or date, so it joins the prescription scanned last; nothing in the first QR says one follows. */
export function addDrugs(qr: DrugsQR, scanned = ''): Scanned {
  const item = items.at(-1);
  if (!item || printed) return { message: '這張 QR 只有藥品，是處方的第 2 個 QR。請先掃同一張處方的第 1 個 QR（有姓名與日期的那個），再掃這個。' };
  const index = items.length;
  const key = qr.drugs.map(drug => `${drug.code}:${drug.total}`).join('|');
  if (item.more.includes(key)) return { message: `這個藥品 QR 已加入第 ${index} 張，不重複加入。` };
  item.more.push(key);
  item.qrs++;
  const drugs: Drug[] = qr.drugs.map(drug => ({ ...drug, missing: false, name: '', quantity: '', note: '', products: [] }));
  drugs.forEach(identify);
  item.drugs.push(...drugs);
  item.rx.drugs.push(...qr.rx);
  if (item.sample && scanned) {
    const joined = withDrugs(item.sample, scanned);
    item.sample = joined.sample;
    if (joined.failed) void rejected.add(scanned, joined.failed);
  }
  listDrugs(item);
  showChecks();
  update();
  return { message: `已把 ${drugs.length} 個藥加入第 ${index} 張${item.name ? `（${item.name}）` : ''}的藥品清單。藥品 QR 沒有姓名與日期，只會接在最後掃入的處方；不是同一張處方請按該張的「移除本單」後重掃。`, card: item.element };
}

// A mobile number ticks 簡訊發送, any other number 電話通知; this runs before the panel's update below.
phone.addEventListener('input', () => {
  const kind = contactKind(phone.value);
  if (kind === contact) return;
  contact = kind;
  sms.checked = kind === 'mobile';
  call.checked = kind === 'phone';
});
panel.addEventListener('input', update);
panel.addEventListener('change', update);
element('slip-clear').addEventListener('click', () => {
  if (!confirm('確定要清空憑單？已掃入的處方、尚差品項、聯絡電話與備註都會清除，無法復原。')) return;
  clearSlip();
  scanStatus.textContent = '';
});
element('slip-print').addEventListener('click', async () => {
  try {
    const data = slipData();
    status.textContent = '準備列印…';
    await printSlip(sheet, data);
    printed = true;
    const printedText = status.textContent = '已送出列印。下一張處方掃入時會自動開始新的憑單；需要重印請再按「列印憑單」。';
    const shared = await shareSamples();
    if (shared && status.textContent === printedText) status.textContent = `${printedText}${shared}`;
  } catch (error) { status.textContent = (error as Error).message; }
});
/**
 * After printing, the slip's prescriptions not yet sent go to the sample sheet with the failures not sent yet. The check summary
 * needs the rule data; when it cannot load the lines go without it. A failed request is tried again on the next print.
 */
async function shareSamples(): Promise<string> {
  if (!samples) return '';
  const fresh = items.filter(item => item.sample && !item.sent);
  const failed = rejected.take();
  if (!fresh.length && !failed.length) return '';
  for (const item of fresh) item.sent = true;
  let data = rxData;
  if (!data) try { data = rxData = await loadRxData(); } catch { /* Sent without the check summary. */ }
  try {
    await sendSamples(sampleRecords(fresh.map(item => item.sample!), failed, data, __APP_VERSION__, new Date().toISOString()), SAMPLE_ENDPOINT);
    return fresh.length ? `已送出 ${fresh.length} 張處方的去識別化樣本。` : '';
  } catch {
    for (const item of fresh) item.sent = false;
    rejected.restore(failed);
    return '去識別化樣本沒有送出（網路問題），不影響憑單；重印時會再送一次。';
  }
}
// Failures still waiting go now, in a request that outlives the page; the slip itself is cleared.
window.addEventListener('pagehide', () => { void rejected.flush(); clearSlip(); });
clearSlip();
