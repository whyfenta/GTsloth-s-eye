import { taiwanToday } from './arithmetic-model';
import { loadRoster, ROSTER_SOURCE, unknownInstitution } from './institutions';
import type { SlipQR } from './prescription-qr';
import { buildSlip, prescriptionAhead, MISSING_ROWS, type MissingItem, type SlipEntry, type Trip } from './slip-model';
import { printSlip } from './slip-print';

// Every scanned prescription joins the slip; identifying fields live only in these objects and the inputs below.
interface Drug { code: string; total: string; missing: boolean; name: string; quantity: string; note: string }
interface Item extends SlipEntry { key: string; institution: string; drugs: Drug[]; element: HTMLLIElement; heading: HTMLElement; state: HTMLElement; hospitalNote: HTMLElement }
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
let items: Item[] = [];
/** After printing, the next scan starts a new slip so two patients are never merged by accident. */
let printed = false;

const fullDate = (value: string) => value.replaceAll('-', '/');
const monthDay = (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
const tripText = (value: Trip) => `${monthDay(value.start)}～${monthDay(value.end)} x${value.prescriptions}`;
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
function choice(options: [string, string][], onChange: (value: number | undefined) => void): HTMLSelectElement {
  const select = make('select');
  for (const [value, text] of options) select.add(new Option(text, value));
  select.addEventListener('change', () => onChange(Number(select.value) || undefined));
  return select;
}

function describe(item: Item) {
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
  const fromQR = items.flatMap(item => item.drugs.filter(drug => drug.missing).map(({ code, name, quantity, note }) => ({ code, name, quantity, note })));
  const typed = [...others.querySelectorAll<HTMLElement>('.slip-other')].map(row => {
    const [code, name, quantity, remark] = [...row.querySelectorAll('input')].map(input => input.value.trim());
    return { code, name, quantity, note: remark };
  }).filter(row => row.code || row.name);
  return [...fromQR, ...typed];
}
function slipData() {
  return buildSlip(items, { phone: phone.value.trim(), sms: sms.checked, call: call.checked, note: note.value.trim(), staff: staff.value.trim(), missing: missingItems() }, taiwanToday());
}
/** The preview shows what will print, or the first reason it cannot. */
function update() {
  items.forEach((item, index) => { item.heading.textContent = `第 ${index + 1} 張 · ${item.name || '（無姓名）'}`; describe(item); });
  body.hidden = !items.length;
  empty.hidden = !!items.length;
  preview.replaceChildren();
  if (!items.length) return;
  try {
    const data = slipData();
    const lines = [
      data.second ? `第二次預計領藥日 ${tripText(data.second)}` : '',
      data.third ? `第三次預計領藥日 ${tripText(data.third)}` : '',
      !data.second && !data.third ? '沒有下次領藥區間，預計領藥日留白。' : '',
      `領藥最終有效時間 ${fullDate(data.validUntil)}`,
      data.names.includes('、') ? `合併病人：${data.names}` : '',
      ...data.notes,
    ].filter(Boolean);
    preview.append(...lines.map(line => make('p', '', line)));
  } catch (error) { preview.append(make('p', 'error', (error as Error).message)); }
}

function drugRow(drug: Drug): HTMLElement {
  const row = make('div', 'slip-drug');
  const box = make('input');
  box.type = 'checkbox';
  const detail = make('div', 'slip-drug-detail');
  detail.hidden = true;
  detail.append(
    textInput(drug.name, '品名', value => { drug.name = value.trim(); }),
    textInput(drug.quantity, '缺藥數量', value => { drug.quantity = value.trim(); }),
    textInput(drug.note, '備註', value => { drug.note = value.trim(); }));
  box.addEventListener('change', () => { drug.missing = box.checked; detail.hidden = !box.checked; });
  const label = make('label', 'slip-check');
  label.append(box, ` ${drug.code}（總量 ${drug.total}）`);
  row.append(label, detail);
  return row;
}
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
  fields.append(
    labelled('姓名', textInput(item.name, '', value => { item.name = value.trim(); })),
    labelled('醫院名稱', hospital),
    labelled('可調劑次數', choice([['', '請選擇'], ['2', '2 次'], ['3', '3 次']], value => { item.count = value; })),
    labelled('本次第幾次', choice([['', '依今日判斷'], ['1', '第 1 次'], ['2', '第 2 次'], ['3', '第 3 次']], value => { item.visit = value; })));
  const drugs = make('fieldset', 'slip-drugs');
  drugs.append(make('legend', '', '尚差藥品（預設不缺，有缺才勾選）'), ...item.drugs.map(drugRow));
  li.append(head, fields, item.hospitalNote, item.state, drugs);
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
  for (const input of [phone, note]) input.value = '';
  sms.checked = call.checked = false;
  status.textContent = '';
  update(); // 承辦人員 stays for the next patient; it is not patient data.
}
/** Adds a scanned prescription and returns the message for the scan field. */
export function addPrescription(qr: SlipQR): string {
  const restarted = printed;
  if (printed) clearSlip();
  status.textContent = '';
  const key = [qr.institution, qr.idNumber, qr.name, qr.date, qr.days, ...qr.drugs.map(drug => drug.code)].join('|');
  const existing = items.findIndex(item => item.key === key);
  if (existing >= 0) return `這張處方已在憑單第 ${existing + 1} 張，不重複加入。`;
  // The owed quantity is whatever the store is short of, so it is typed, not taken from the QR total.
  const item: Item = { key, institution: qr.institution, date: qr.date, days: qr.days, name: qr.name, idNumber: qr.idNumber, birth: qr.birth, hospital: '',
    drugs: qr.drugs.map(drug => ({ ...drug, missing: false, name: '', quantity: '', note: '' })),
    element: make('li', 'slip-item'), heading: make('strong'), state: make('p', 'slip-item-state'), hospitalNote: make('p', 'hint slip-hospital-note') };
  fillItem(item);
  items.push(item);
  list.append(item.element);
  lookup(item);
  update();
  return `${restarted ? '上一張憑單已列印，已開始新的憑單；' : ''}已加入第 ${items.length} 張${qr.name ? `（${qr.name}）` : ''}，請在憑單選擇可調劑次數。`
    + (qr.idNumber ? '' : '讀不到身分證字號，門市存查聯不印此人的身分證。');
}

panel.addEventListener('input', update);
panel.addEventListener('change', update);
element('slip-clear').addEventListener('click', clearSlip);
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
