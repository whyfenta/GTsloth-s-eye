import { addDays, taiwanToday, type DateRange } from './arithmetic-model';
import { loadRoster, ROSTER_SOURCE, unknownInstitution } from './institutions';
import type { SlipQR } from './prescription-qr';
import { loadProducts } from './products';
import { buildSlip, planSlip, prescriptionAhead, MISSING_ROWS, type MissingItem, type Product, type SlipEntry, type SlipPlan, type Trip } from './slip-model';
import { printSlip } from './slip-print';

// Every scanned prescription joins the slip; identifying fields live only in these objects and the inputs below.
// products: the 六碼 the product lookup gives the 健保碼; product: the one on the slip, chosen when there are several.
interface Drug { code: string; total: string; missing: boolean; name: string; quantity: string; note: string; products: Product[]; product?: Product }
interface Item extends SlipEntry { key: string; institution: string; drugs: Drug[]; element: HTMLLIElement; heading: HTMLElement; state: HTMLElement; hospitalNote: HTMLElement;
  drugList: HTMLFieldSetElement; counts: HTMLInputElement[]; visits: HTMLInputElement[] }
type Row = 'second' | 'third';
interface TripRow { row: Row; element: HTMLElement; start: HTMLInputElement; end: HTMLInputElement; count: HTMLElement; reset: HTMLButtonElement; hint: HTMLElement }
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const panel = element('slip-panel');
const body = element('slip-body');
const empty = element('slip-empty');
const list = element<HTMLOListElement>('slip-items');
const preview = element('slip-plan');
const others = element('slip-others');
const status = element('slip-status');
const sheet = element('slip-sheet');
const phone = element<HTMLInputElement>('slip-phone');
const staff = element<HTMLInputElement>('slip-staff');
const sms = element<HTMLInputElement>('slip-sms');
const call = element<HTMLInputElement>('slip-call');
const note = element<HTMLTextAreaElement>('slip-note');
const tripBox = element('slip-trips');
const scanField = element<HTMLInputElement>('prescription-date');
let items: Item[] = [];
/** 健保碼 → 六碼, loaded on the first scan. */
let catalog: Map<string, Product[]> | undefined;
/** The calculated trips, and dates agreed with the patient in their place; base is the window they replaced. */
let plan: SlipPlan | undefined;
let agreed: Partial<Record<Row, { base: Trip; range: DateRange }>> = {};
/** A scanner may end a code with two Enters; the second must not confirm the default refill count. */
let scannedAt = 0;
/** After printing, the next scan starts a new slip so two patients are never merged by accident. */
let printed = false;

const fullDate = (value: string) => value.replaceAll('-', '/');
const monthDay = (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
const sameTrip = (a: Trip, b: Trip) => a.start === b.start && a.end === b.end && a.prescriptions === b.prescriptions;
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
    radio.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); onEnter(); } });
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
    item.state.textContent = `${item.visit ? '' : '依今日判斷'}第 ${ahead.visit} 次：${message}${next ? `接下來：${next}。` : ahead.result.state === 'invalid' ? '' : '已無下次領藥，下次請回診。'}`;
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
  } catch (error) { preview.append(make('p', 'error', (error as Error).message)); }
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
const listDrugs = (item: Item) => item.drugList.replaceChildren(make('legend', '', '尚差藥品（預設不缺，有缺才勾選）'), ...item.drugs.map(drugRow));
function fillItem(item: Item) {
  const li = item.element;
  const head = make('div', 'slip-item-head');
  const remove = make('button', '', '移除');
  remove.type = 'button';
  remove.addEventListener('click', () => { items = items.filter(other => other !== item); li.remove(); status.textContent = ''; update(); });
  head.append(item.heading, make('span', 'hint', `處方 ${fullDate(item.date)} · ${item.days} 天`), remove);
  const fields = make('div', 'slip-item-fields');
  const hospital = textInput(item.hospital, '查詢醫院名冊中…', value => { item.hospital = value; });
  hospital.dataset.role = 'hospital';
  // Scan → refill count (2 by default) → visit (inferred by default) → back to the scan field for the next prescription.
  const count = segmented('可調劑次數', [[2, '2 次'], [3, '3 次']], value => { item.count = value; },
    () => { if (performance.now() - scannedAt > 300) focusChoice(item.visits); });
  const visit = segmented('本次第幾次', [[1, '第 1 次'], [2, '第 2 次'], [3, '第 3 次']], value => { item.visit = value; }, () => scanField.focus());
  item.counts = count.radios; item.visits = visit.radios;
  fields.append(
    labelled('姓名', textInput(item.name, '', value => { item.name = value.trim(); })),
    labelled('醫院名稱', hospital), count.field, visit.field);
  listDrugs(item);
  li.append(head, fields, item.hospitalNote, item.state, item.drugList);
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
element('slip-add-other').addEventListener('click', () => {
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
  status.textContent = '';
  update(); // 承辦人員 stays for the next patient; it is not patient data.
}
/** Adds a scanned prescription; returns the message for the scan field and, when added, the control to type into next. */
export function addPrescription(qr: SlipQR): { message: string; focus?: HTMLElement } {
  const restarted = printed;
  if (printed) clearSlip();
  status.textContent = '';
  const key = [qr.institution, qr.idNumber, qr.name, qr.date, qr.days, ...qr.drugs.map(drug => drug.code)].join('|');
  const existing = items.findIndex(item => item.key === key);
  if (existing >= 0) return { message: `這張處方已在憑單第 ${existing + 1} 張，不重複加入。` };
  // The owed quantity is whatever the store is short of, so it is typed, not taken from the QR total.
  const item: Item = { key, institution: qr.institution, date: qr.date, days: qr.days, count: 2, name: qr.name, idNumber: qr.idNumber, birth: qr.birth, hospital: '',
    drugs: qr.drugs.map(drug => ({ ...drug, missing: false, name: '', quantity: '', note: '', products: [] })),
    element: make('li', 'slip-item'), heading: make('strong'), state: make('p', 'slip-item-state'), hospitalNote: make('p', 'hint slip-hospital-note'),
    drugList: make('fieldset', 'slip-drugs'), counts: [], visits: [] };
  item.drugs.forEach(identify);
  fillItem(item);
  items.push(item);
  list.append(item.element);
  lookup(item);
  if (!catalog) loadProducts().then(loaded => {
    if (catalog) return;
    catalog = loaded.index;
    for (const other of items) { other.drugs.forEach(identify); listDrugs(other); }
    update();
  }).catch((error: Error) => { status.textContent = error.message; });
  update();
  scannedAt = performance.now();
  return { message: `${restarted ? '上一張憑單已列印，已開始新的憑單；' : ''}已加入第 ${items.length} 張${qr.name ? `（${qr.name}）` : ''}。可調劑次數預設 2 次、本次第幾次依日期推算：以方向鍵選擇，Enter 確認後回到掃碼欄。`
    + (qr.idNumber ? '' : '讀不到身分證字號，門市存查聯不印此人的身分證。'), focus: item.counts.find(radio => radio.checked) };
}

panel.addEventListener('input', update);
panel.addEventListener('change', update);
element('slip-clear').addEventListener('click', () => {
  if (confirm('確定要清空憑單？已掃入的處方、尚差品項、聯絡電話與備註都會清除，無法復原。')) clearSlip();
});
element('slip-print').addEventListener('click', async () => {
  try {
    const data = slipData();
    status.textContent = '準備列印…';
    await printSlip(sheet, data);
    printed = true;
    status.textContent = '已送出列印。下一張處方掃入時會自動開始新的憑單；需要重印請再按「列印憑單」。';
  } catch (error) { status.textContent = (error as Error).message; }
});
window.addEventListener('pagehide', clearSlip);
clearSlip();
