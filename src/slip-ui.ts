import { taiwanToday } from './arithmetic-model';
import { decodeCsv } from './csv';
import { loadRoster, ROSTER_SOURCE, unknownInstitution } from './institutions';
import type { SlipQR } from './prescription-qr';
import { buildSlip, prescriptionAhead, productIndex, MISSING_ROWS, type MissingItem, type Product, type SlipEntry, type Trip } from './slip-model';
import { printSlip } from './slip-print';
import { readMap } from './sku-map';

// Every scanned prescription joins the slip; identifying fields live only in these objects and the inputs below.
// products: the 六碼 the loaded map gives the 健保碼; product: the one on the slip, chosen when there are several.
interface Drug { code: string; total: string; missing: boolean; name: string; quantity: string; note: string; products: Product[]; product?: Product }
interface Item extends SlipEntry { key: string; institution: string; drugs: Drug[]; element: HTMLLIElement; heading: HTMLElement; state: HTMLElement; hospitalNote: HTMLElement; drugList: HTMLFieldSetElement }
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
const mapFile = element<HTMLInputElement>('slip-map-file');
const mapStatus = element('slip-map-status');
let items: Item[] = [];
/** sku-nhi-map.csv is private, so the site never ships it: the user picks a copy, which stays in page memory only. */
let catalog: Map<string, Product[]> | undefined;
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
function drugText(drug: Drug): string {
  const total = `（總量 ${drug.total}）`;
  if (drug.product) return `${drug.product.sku} ${drug.product.name}${total}`;
  if (!drug.products.length) return `${drug.code}${total}${catalog ? ' · 對照檔查無此健保碼' : ''}`;
  return `${drug.products.map(product => product.sku).join('／')} ${[...new Set(drug.products.map(product => product.name))].join('／')}${total}`;
}
function drugRow(drug: Drug): HTMLElement {
  const row = make('div', 'slip-drug');
  const box = make('input');
  box.type = 'checkbox';
  box.checked = drug.missing;
  const detail = make('div', 'slip-drug-detail');
  detail.hidden = !drug.missing;
  const text = make('span', '', drugText(drug));
  const name = textInput(drug.name, '品名', value => { drug.name = value.trim(); });
  if (drug.products.length > 1) {
    const select = make('select');
    select.setAttribute('aria-label', '缺的是哪一個六碼');
    select.add(new Option(`請選擇六碼（此健保碼對到 ${drug.products.length} 個）`, ''));
    for (const product of drug.products) select.add(new Option(`${product.sku} ${product.full}`, product.sku));
    select.value = drug.product?.sku ?? '';
    select.addEventListener('change', () => {
      choose(drug, drug.products.find(product => product.sku === select.value));
      name.value = drug.name;
      text.textContent = drugText(drug);
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
  fields.append(
    labelled('姓名', textInput(item.name, '', value => { item.name = value.trim(); })),
    labelled('醫院名稱', hospital),
    labelled('可調劑次數', choice([['', '請選擇'], ['2', '2 次'], ['3', '3 次']], value => { item.count = value; })),
    labelled('本次第幾次', choice([['', '依今日判斷'], ['1', '第 1 次'], ['2', '第 2 次'], ['3', '第 3 次']], value => { item.visit = value; })));
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
    drugs: qr.drugs.map(drug => ({ ...drug, missing: false, name: '', quantity: '', note: '', products: [] })),
    element: make('li', 'slip-item'), heading: make('strong'), state: make('p', 'slip-item-state'), hospitalNote: make('p', 'hint slip-hospital-note'), drugList: make('fieldset', 'slip-drugs') };
  item.drugs.forEach(identify);
  fillItem(item);
  items.push(item);
  list.append(item.element);
  lookup(item);
  update();
  return `${restarted ? '上一張憑單已列印，已開始新的憑單；' : ''}已加入第 ${items.length} 張${qr.name ? `（${qr.name}）` : ''}，請在憑單選擇可調劑次數。`
    + (qr.idNumber ? '' : '讀不到身分證字號，門市存查聯不印此人的身分證。');
}

element('slip-map-load').addEventListener('click', () => mapFile.click());
mapFile.addEventListener('change', async () => {
  const file = mapFile.files?.[0];
  if (!file) return;
  try {
    const map = readMap(decodeCsv(new Uint8Array(await file.arrayBuffer())));
    catalog = productIndex(map.values());
    const skus = [...catalog.values()].reduce((sum, products) => sum + products.length, 0);
    mapStatus.textContent = `已載入 ${file.name}：${catalog.size.toLocaleString()} 個健保碼對到 ${skus.toLocaleString()} 個六碼，對得到的藥品以六碼＋品名顯示與列印。對照檔只留在本頁記憶體，關閉頁面即清除。`;
    for (const item of items) { item.drugs.forEach(identify); listDrugs(item); }
    update();
  } catch (error) {
    // A wrong file can have thousands of problems; the first few say enough.
    const reason = (error as Error).message.split('\n').slice(0, 4).map(line => line.trim()).join(' ');
    mapStatus.textContent = `無法載入 ${file.name}：${reason}${catalog ? ' 仍使用先前載入的對照檔。' : ''}`;
  } finally { mapFile.value = ''; } // Picking the same file again reloads it.
});
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
