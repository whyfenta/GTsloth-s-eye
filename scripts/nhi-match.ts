import { cleanProductName, normalizeOCR } from '../src/model';
import { csvRows } from './roster';

// 商品代號（六碼）對健保藥品代號：讀健保用藥品項精簡檔、解析庫存簡表品名、以名稱比對候選健保碼。
// Used by scripts/nhi-map.ts; the website loads none of this. The report carries no 健保碼 and its 國際條碼 are not in
// the NHI file, so names are the only link. A 六碼 settled once goes into docs/reference/sku-nhi-map.csv (nhi-map.ts)
// and later reports look it up there instead of matching again.

/** ROC date as the NHI file prints it, YYYMMDD: 1151025 is 2026-10-25. */
export type RocDay = string;
export const rocDay = (iso: string): RocDay => { const [y, m, d] = iso.split('-').map(Number); return `${y - 1911}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`; };
export const rocLabel = (roc: RocDay) => `${Number(roc.slice(0, -4))}/${roc.slice(-4, -2)}/${roc.slice(-2)}`;

type Base = 'injection' | 'inhaler' | 'suppository' | 'patch' | 'topical' | 'granule' | 'capsule' | 'tablet' | 'liquid';
/** Dosage form. base and route must agree when both sides name one; release mods and the topical kind only weigh in. */
type Form = { base?: Base; topical?: string; mods: Set<string>; route?: string };
// Checked in this order, so 注射液劑 is an injection, 懸液用顆粒劑 a granule and 定量噴霧液 an inhaler.
const BASES: [Base, RegExp][] = [
  ['injection', /注射|輸注|點滴|筆/], ['inhaler', /吸入|噴霧/], ['suppository', /栓劑|塞劑/], ['patch', /貼片|貼布|膠布/],
  ['topical', /膏|凝膠|乳霜|洗劑/], ['granule', /顆粒|粒劑|散劑|粉劑|細粒|粉$/], ['capsule', /膠囊/], ['tablet', /錠|片/],
  ['liquid', /液|糖漿|懸浮|乳劑|酏|酊|滴劑|油劑|眼水|藥水/],
];
const TOPICAL: [string, RegExp][] = [['乳膏', /乳膏|乳霜/], ['軟膏', /軟膏|眼膏|藥膏|口內膏/], ['凝膠', /凝膠/], ['洗劑', /洗劑/]];
const MODS: [string, RegExp][] = [
  ['持續性', /持續|長效|緩釋|控釋|延釋|延長|徐放|\b(?:XR|SR|ER|LA|CR|XL|RETARD|PROLONGED|EXTENDED|SUSTAINED|CONTROLLED|MODIFIED|OROS)\b/i],
  ['口溶', /口溶|口崩|口腔崩散|口頰溶|\b(?:ODT|OD|DISCMELT|ORODISPERSIBLE)\b|ORALLY DISINTEGRATING/i],
  ['腸溶', /腸溶|腸衣|\bENTERIC\b|GASTRO-RESISTANT/i], ['發泡', /發泡|\bEFFERVESCENT\b/i], ['咀嚼', /咀嚼|嚼錠|\bCHEWABLE\b/i], ['舌下', /舌下|\bSUBLINGUAL\b/i],
];
const ROUTES: [string, RegExp][] = [['眼', /眼用|點眼|眼藥|眼膏|眼液|眼水/], ['鼻', /鼻用|點鼻|鼻噴|鼻腔/], ['耳', /耳用|點耳|耳滴/], ['陰道', /陰道/]];
/** form: the dosage-form words only (the NHI 劑型, or a store name without its brand); text: the whole name for release words. */
function formOf(form: string, text: string): Form {
  return { base: BASES.find(([, pattern]) => pattern.test(form))?.[0], topical: TOPICAL.find(([, pattern]) => pattern.test(form))?.[0],
    mods: new Set(MODS.filter(([, pattern]) => pattern.test(form) || pattern.test(text)).map(([name]) => name)), route: ROUTES.find(([, pattern]) => pattern.test(form))?.[0] };
}
// What is left of a Chinese name once the form words are cut off is the brand (力必平膜衣錠 → 力必平, 滅咳康複合膠囊 → 滅咳康).
const FORM_WORDS = /持續|長效|緩釋|控釋|延釋|膜衣|糖衣|口溶|口崩|腸溶|發泡|咀嚼|舌下|軟膠囊|膠囊|微粒|錠|顆粒|粒劑|散劑|粉|乳膏|軟膏|藥膏|凝膠|乳霜|洗劑|眼用|點眼|眼液|眼水|眼藥|鼻用|點鼻|耳用|耳滴|無菌|單支|懸液|懸浮|懸乳|糖漿|內服|口服|液|乳劑|栓劑|噴霧|吸入|氣化|定量|注射|筆|貼片|片|複合|酊/;

/** A strength or package size in comparable units: mass in mg, concentrations (mg/mL, mg/g, %) as %, units as u. */
export type Amount = { unit: 'mg' | '%' | 'u' | 'u/ml' | 'g' | 'ml' | 'dose'; value: number; loose?: boolean };
const MASS: Record<string, number> = { MG: 1, 毫克: 1, 公絲: 1, MCG: 0.001, UG: 0.001, ΜG: 0.001, 微克: 0.001, 微公克: 0.001, G: 1000, GM: 1000, 公克: 1000 };
const VOLUME = new Set(['ML', '毫升', '公撮']); const WEIGHT = new Set(['G', 'GM', '公克']);
const AMOUNT = /(\d*\.?\d+(?:\s*\/\s*\d*\.?\d+)*)\s*(MCG|UG|ΜG|MG|GM|G|ML|IU|U|%|毫克|公絲|微公克|微克|公克|毫升|公撮|萬單位|DOSE)(?![A-Z])(?:\s*\/\s*(\d*\.?\d+)?\s*(ML|GM|G|DOSE|TAB|HR|PUFF|劑量|毫升|公撮|公克))?/gi;
const round = (value: number) => Number(value.toPrecision(6));
/**
 * Amounts printed in a name or 成分. grams: G without a denominator is a package size (5G cream, 2.5G sachet) rather
 * than a strength, true for everything but tablets and capsules. In 5/80MG the unit belongs to every number; in
 * 70/5600IU it may not, so all but the last of such a run are loose and also match on the bare number.
 */
export function amountsOf(text: string, grams: boolean): { strengths: Amount[]; sizes: Amount[] } {
  const strengths: Amount[] = []; const sizes: Amount[] = [];
  for (const [, numbers, rawUnit, perCount, rawPer] of text.normalize('NFKC').toUpperCase().matchAll(AMOUNT)) {
    const unit = rawUnit.toUpperCase(); const per = rawPer?.toUpperCase(); const divisor = perCount ? Number(perCount) : 1;
    const values = numbers.split('/').map(n => Number(n.trim()));
    values.forEach((value, i) => {
      const loose = i < values.length - 1 ? { loose: true } : {}; const mass = MASS[unit];
      if (unit === '%') strengths.push({ unit: '%', value: round(value), ...loose });
      else if (unit === 'IU' || unit === 'U' || unit === '萬單位') {
        const units = unit === '萬單位' ? value * 10000 : value;
        strengths.push(per && VOLUME.has(per) ? { unit: 'u/ml', value: round(units / divisor), ...loose } : { unit: 'u', value: round(units), ...loose });
      } else if (VOLUME.has(unit)) sizes.push({ unit: 'ml', value: round(value) });
      else if (unit === 'DOSE') sizes.push({ unit: 'dose', value: round(value) });
      else if (per && (VOLUME.has(per) || WEIGHT.has(per))) {
        strengths.push({ unit: '%', value: round(value * mass / divisor / 10), ...loose });
        // 2MG/1.5ML is a pen of 1.5 mL.
        if (perCount && VOLUME.has(per)) sizes.push({ unit: 'ml', value: round(divisor) });
      }
      else if (mass === 1000 && !per && grams) sizes.push({ unit: 'g', value: round(value) });
      else strengths.push({ unit: 'mg', value: round(value * mass), ...loose });
    });
  }
  return { strengths, sizes };
}
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 + Math.abs(a) * 0.01;
const sameAmount = (a: Amount, b: Amount) => a.unit === b.unit && close(a.value, b.value);
const NUMBER = /\d*\.?\d+/g;
const numbersOf = (text: string) => [...text.normalize('NFKC').matchAll(NUMBER)].map(([n]) => String(Number(n)));

/** English name words: uppercase letters and digits. */
const words = (text: string) => text.normalize('NFKC').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
const HAN = /\p{Script=Han}/u;
const hanOnly = (text: string) => [...text.normalize('NFKC')].filter(c => HAN.test(c)).join('').replace(/臺/g, '台');
// Unit words dropped before comparing whole Chinese names: 利福全2毫克錠 is still 利福全錠.
const UNIT_WORDS = /毫克|公絲|微公克|微克|公克|毫升|公撮|國際單位|單位|劑量/g;
// Short maker names in the store's [廠牌] tag, as the NHI 藥商 / 製造廠 columns spell them.
const MAKER_ALIAS: Record<string, string[]> = { 中化: ['中國化學'], 台田: ['台灣田邊'], 諾華: ['諾華', 'NOVARTIS'], 拜耳: ['拜耳', 'BAYER'], 輝瑞: ['輝瑞', 'PFIZER'] };

export type NhiPeriod = { start: RocDay; end: RocDay; price: number };
export type NhiCode = {
  code: string; en: string; zh: string; ingredients: string; size: string; sizeUnit: string; form: string; firm: string; maker: string;
  periods: NhiPeriod[]; lastPrice: string; lastEnd: string;
};
type Indexed = NhiCode & {
  words: string[]; joined: Set<string>; han: string; whole: string; feature: Form; strengths: Amount[]; named: Amount[]; numbers: Set<string>; pack?: Amount; parts: number;
};
export type Nhi = { codes: Map<string, NhiCode>; byLicence: Map<string, NhiCode[]>; byWord: Map<string, Indexed[]>; sortedWords: string[]; byBigram: Map<string, Indexed[]> };
const COLUMNS = ['藥品代號', '藥品英文名稱', '藥品中文名稱', '成分', '規格量', '規格單位', '支付價', '有效起日', '有效迄日', '藥商', '製造廠名稱', '劑型', '最後給付價', '最後給付迄日'];
const price = (text: string) => { const value = Number(text); return Number.isFinite(value) ? value : 0; };
// 規格量 units: package sizes, and the content of a patch or pen, which the store prints as the strength (4.6MG, 300U).
const PACK: Record<string, [Amount['unit'], number]> = { ML: ['ml', 1], 'L (LITER)': ['ml', 1000], GM: ['g', 1], KG: ['g', 1000], DOSE: ['dose', 1] };
const CONTENT: Record<string, [Amount['unit'], number]> = { MG: ['mg', 1], MCG: ['mg', 0.001], IU: ['u', 1], 'U (UNIT)': ['u', 1], KIU: ['u', 1000] };

/** docs/reference/nhi-drug-codes.csv, one entry per 藥品代號 with its periods oldest first. */
export function loadNhi(text: string): Nhi {
  const [header, ...rows] = csvRows(text.replace(/^\uFEFF/, ''));
  const at = COLUMNS.map(name => { const i = header.indexOf(name); if (i < 0) throw new Error(`健保檔缺少欄位：${name}`); return i; });
  const codes = new Map<string, NhiCode>();
  for (const row of rows) {
    const [code, en, zh, ingredients, size, sizeUnit, pay, start, end, firm, maker, form, lastPrice, lastEnd] = at.map(i => (row[i] ?? '').trim());
    const period = { start: start.padStart(7, '0'), end: end.padStart(7, '0'), price: price(pay) };
    const known = codes.get(code);
    if (known) known.periods.push(period);
    else codes.set(code, { code, en, zh, ingredients, size, sizeUnit, form, firm, maker, periods: [period], lastPrice, lastEnd });
  }
  const byLicence = new Map<string, NhiCode[]>(); const byWord = new Map<string, Indexed[]>(); const byBigram = new Map<string, Indexed[]>();
  const add = <T>(map: Map<string, T[]>, key: string, entry: T) => { const list = map.get(key); if (!list) map.set(key, [entry]); else if (list.at(-1) !== entry) list.push(entry); };
  for (const entry of codes.values()) {
    entry.periods.sort((a, b) => a.start.localeCompare(b.start));
    add(byLicence, licence(entry.code), entry);
    const indexed = index(entry);
    for (const word of [...indexed.words, ...indexed.joined]) add(byWord, word, indexed);
    for (let i = 0; i + 2 <= indexed.han.length; i++) add(byBigram, indexed.han.slice(i, i + 2), indexed);
  }
  return { codes, byLicence, byWord, sortedWords: [...byWord.keys()].sort(), byBigram };
}
function index(entry: NhiCode): Indexed {
  const nameWords = words(entry.en);
  // "U-Ca", "HI-BESTON" and "(O.N.S.D.)" are one brand: runs of up to four words are also kept joined.
  const joined = new Set<string>();
  for (let i = 0; i < nameWords.length; i++) for (let n = 2; n <= 4 && i + n <= nameWords.length; n++) joined.add(nameWords.slice(i, i + n).join(''));
  const feature = formOf(entry.form || entry.zh, `${entry.zh} ${entry.en}`);
  const grams = feature.base !== 'tablet' && feature.base !== 'capsule';
  const named = [entry.en, entry.zh].flatMap(text => amountsOf(text, grams).strengths);
  const strengths = [...amountsOf(entry.ingredients, false).strengths, ...named];
  const unit = entry.sizeUnit.toUpperCase(); const value = Number(entry.size);
  let pack: Amount | undefined;
  if (value > 0 && PACK[unit]) pack = { unit: PACK[unit][0], value: round(value * PACK[unit][1]) };
  else if (value > 0 && CONTENT[unit]) strengths.push({ unit: CONTENT[unit][0], value: round(value * CONTENT[unit][1]) });
  const han = hanOnly(entry.zh);
  return { ...entry, words: nameWords, joined, han, whole: han.replace(UNIT_WORDS, ''), feature, strengths, named,
    numbers: new Set([entry.en, entry.zh, entry.ingredients].flatMap(numbersOf)), pack, parts: entry.ingredients.split('+').filter(Boolean).length };
}

/** Same 藥證: the 1st and 3rd–8th characters agree (A045031100 and AC450311G0); the 2nd varies with the price history. */
export const licence = (code: string) => code[0] + code.slice(2, 8);
export type Status = { paid: boolean; price: number; stop?: RocDay; change?: { day: RocDay; price: number } };
/** 給付 on `day`: the period holding that day pays more than 0. stop / change: the next period ends or alters that. */
export function status(entry: NhiCode, day: RocDay): Status {
  const now = entry.periods.find(p => p.start <= day && day <= p.end); const paid = !!now && now.price > 0;
  const next = entry.periods.find(p => p.start > day);
  return { paid, price: now?.price ?? 0, ...(paid && next && next.price === 0 ? { stop: next.start } : {}),
    ...(next && next.price > 0 && next.price !== now?.price ? { change: { day: next.start, price: next.price } } : {}) };
}
export function statusLabel(entry: NhiCode | undefined, day: RocDay): string {
  if (!entry) return '健保檔無此碼';
  const s = status(entry, day);
  if (!s.paid) return entry.lastEnd ? `未給付（最後給付至 ${rocLabel(entry.lastEnd.padStart(7, '0'))}，${entry.lastPrice} 元）` : '未給付';
  return [`給付中 ${s.price} 元`, s.stop ? `${rocLabel(s.stop)} 起停止給付` : '', s.change ? `${rocLabel(s.change.day)} 起改為 ${s.change.price} 元` : ''].filter(Boolean).join('，');
}

/**
 * What a 庫存簡表 name says about the product. key: the name with only its status words (避光、缺貨、追追…), class marker
 * and trailing -高健保 tags removed; the package spec stays, since a new package can mean another 健保碼.
 */
export type StoreName = {
  key: string; english: string[]; core: string; whole: string; form: Form; strengths: Amount[]; sizes: Amount[]; bare: string[];
  maker?: string[]; compound: boolean; pack?: '00' | 'G0';
};
// Package spec of counted solids: per 盒 or with an inner (n粒/排) the blister code G0, per 瓶 the plain code 00.
const COUNTED = /^\d+(?:\.\d+)?\s*(?:粒|錠|顆|片|丸)\s*[/／]{1,2}\s*(盒|瓶)/;
const LEADING = /^[A-Za-z][A-Za-z0-9.'&+\-]*(?:\s+[A-Za-z][A-Za-z0-9.'&+\-]*)*/;
export function storeName(raw: string): StoreName {
  const cleaned = cleanProductName(raw, true);
  const packs = cleaned.removed.filter(part => /^\d/.test(part)).map(part => part.trim());
  const key = normalizeOCR(packs.join('') + cleaned.name);
  const counted = packs.map(part => part.match(COUNTED)).find(Boolean);
  const pack = counted ? (counted[1] === '盒' || packs.some(part => /排/.test(part)) ? 'G0' : '00') : undefined;
  let name = cleaned.name.normalize('NFKC').replace(/-?\(?專案(?:進口|製造)\)?/g, ' ');
  const maker = name.match(/\[([^\]]+)\]/)?.[1]?.replace(/臺/g, '台'); const compound = /\(複方\)/.test(name);
  // Per-pack sizes in brackets, (2.5G/包) or (1.5ML), still pick the package code; other bracketed notes are dropped.
  const packed = [...name.matchAll(/\(\s*(\d*\.?\d+\s*(?:G|GM|ML))\s*(?:\/\s*[包支瓶])?\s*\)/gi)].map(([, size]) => size).join(' ');
  name = name.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/-改\d+/g, ' ').replace(/-+\s*$/, '');
  const leading = name.match(LEADING)?.[0] ?? name.match(/[A-Za-z][A-Za-z.\-]{2,}/)?.[0] ?? '';
  const english = words(leading.replace(/\b[FSE]\.C\.?/gi, ' '));
  const rest = name.replace(leading, ' ');
  const han = hanOnly(rest.slice(0, rest.search(/\d/) < 0 ? undefined : rest.search(/\d/)));
  // A brand keeps its first two characters even when one is a form word (保栓通, 舒栓寧).
  const cut = han.slice(2).search(FORM_WORDS); const core = cut >= 0 ? han.slice(0, cut + 2) : han;
  const all = hanOnly(rest); const formWords = all.startsWith(core) ? all.slice(core.length) : all;
  const form = formOf(formWords, `${rest} ${leading}`);
  const { strengths, sizes } = amountsOf(`${rest} ${packed}`, form.base !== 'tablet' && form.base !== 'capsule');
  // Numbers without a unit (使肺泰250優氟吸入劑) still have to appear in the candidate's name.
  const bare = numbersOf(rest.normalize('NFKC').toUpperCase().replace(AMOUNT, ' '));
  return { key, english, core, whole: all.replace(UNIT_WORDS, ''), form, strengths, sizes, bare, maker: maker ? MAKER_ALIAS[maker] ?? [maker] : undefined, compound, pack };
}

export type Candidate = { code: string; score: number; why: string[] };
type Scored = Candidate & { entry: Indexed };
/** clear: one paid 健保碼 was chosen. The others go to a person, with the best candidates. */
export type Match = { kind: 'clear'; code: string; candidates: Candidate[] } | { kind: 'unpaid' | 'codes' | 'ambiguous' | 'maker' | 'none'; candidates: Candidate[] };
export const MATCH_LABEL: Record<Match['kind'], string> = {
  clear: '明確', unpaid: '只對到未給付碼', codes: '同藥證多個現行碼', ambiguous: '多個候選', maker: '品名廠牌與健保檔不符', none: '找不到候選',
};
/** A product needs a brand or Chinese-name hit plus agreeing details (THRESHOLD), and every rival must trail by MARGIN. */
const THRESHOLD = 5; const MARGIN = 2;

function candidates(nhi: Nhi, name: StoreName): Set<Indexed> {
  const found = new Set<Indexed>(); const [first] = name.english;
  const take = (list?: Indexed[]) => { for (const entry of list ?? []) found.add(entry); };
  if (first) {
    take(nhi.byWord.get(name.english.join('')));
    if (first.length >= 3) take(nhi.byWord.get(first));
    // Shortened store names: Telmisart is TELMISARTAN.
    if (first.length >= 5) {
      let lo = 0, hi = nhi.sortedWords.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nhi.sortedWords[mid] < first) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < nhi.sortedWords.length && nhi.sortedWords[i].startsWith(first); i++) take(nhi.byWord.get(nhi.sortedWords[i]));
    }
  }
  if (name.core.length >= 2) for (const entry of nhi.byBigram.get(name.core.slice(0, 2)) ?? []) if (entry.han.includes(name.core)) found.add(entry);
  return found;
}

function score(entry: Indexed, name: StoreName): Scored | undefined {
  const why: string[] = []; let total = 0; let named = false;
  const [first, ...more] = name.english; const joined = name.english.join('');
  if (first) {
    if (entry.joined.has(joined) || entry.words.includes(joined) || (first.length >= 3 && entry.words.includes(first))) { total += 4; why.push('英文名'); named = true; }
    else if (first.length >= 5 && entry.words.some(word => word.startsWith(first))) { total += 3; why.push('英文名縮寫'); named = true; }
    if (named && more.length && !entry.joined.has(joined)) for (const word of more) {
      if (entry.words.some(w => w.startsWith(word))) total += 0.5; else { total -= 1; why.push(`缺 ${word}`); }
    }
  }
  if (name.core.length >= 2 && entry.han.includes(name.core)) {
    total += name.core.length >= 3 ? 3 : 2; why.push('中文名'); named = true;
    if (name.whole.length > name.core.length && entry.whole.includes(name.whole)) { total += 2; why.push('中文全名'); }
  }
  if (!named) return undefined;
  const f = name.form; const e = entry.feature;
  if (f.base && e.base && f.base !== e.base && f.route !== '鼻') return undefined;
  if (f.route && f.route !== e.route) return undefined;
  if (!f.route && e.route) { total -= 1; why.push(`健保檔為${e.route}用`); }
  if (f.topical && e.topical && f.topical !== e.topical && !entry.zh.includes(f.topical)) { total -= 1; why.push(`健保檔為${e.topical}`); }
  for (const mod of new Set([...f.mods, ...e.mods])) if (f.mods.has(mod) !== e.mods.has(mod)) { total -= f.mods.has(mod) ? 3 : 2; why.push(f.mods.has(mod) ? `健保檔無${mod}` : `品名無${mod}`); }
  if (name.strengths.length && entry.strengths.length) {
    // Granules print the per-gram strength as plain MG: 40MG is the 40MG/GM sachet.
    const found = (a: Amount) => entry.strengths.some(b => sameAmount(a, b)) || (a.unit === 'mg' && e.base === 'granule' && entry.strengths.some(b => sameAmount({ unit: '%', value: a.value / 10 }, b)))
      || (!!a.loose && entry.numbers.has(String(a.value)));
    if (name.strengths.every(found)) { total += 2; why.push('含量'); } else { total -= 4; why.push('含量不符'); }
    // Co-Diovan 80/12.5 is not Diovan 80: a strength in the candidate's name that the store name lacks counts against it.
    if (entry.named.some(b => !name.strengths.some(a => sameAmount(a, b) || (a.loose && close(a.value, b.value))))) { total -= 2; why.push('健保品名多含量'); }
  }
  for (const n of name.bare) if (entry.numbers.has(n)) total += 1; else { total -= 2; why.push(`無 ${n}`); }
  for (const size of name.sizes) {
    if (!entry.pack || entry.pack.unit !== size.unit) continue;
    if (!sameAmount(size, entry.pack)) return undefined;
    total += 1; why.push('規格量');
  }
  if (name.maker) {
    const texts = [entry.firm, entry.maker, entry.zh, entry.en].map(text => text.normalize('NFKC').toUpperCase().replace(/臺/g, '台'));
    const hit = name.maker.some(maker => texts.some(text => text.includes(maker)));
    total += hit ? 2 : -2; why.push(hit ? '廠牌' : '廠牌不符');
  }
  if (name.compound && entry.parts === 1) { total -= 2; why.push('健保檔為單方'); }
  return { code: entry.code, score: total, why, entry };
}

/**
 * Name-matches one store product against the NHI file as of `day`. Codes of one 藥證 form one product, ranked by its best
 * code. The store sells what is paid today, so the best paid product wins when nothing unpaid beats it by MARGIN; a
 * product that is paid on none of its matching codes is reported as unpaid rather than chosen.
 */
export function match(nhi: Nhi, raw: string, day: RocDay): Match {
  const name = storeName(raw);
  const products = new Map<string, Scored[]>();
  for (const entry of candidates(nhi, name)) {
    const s = score(entry, name); if (!s) continue;
    const key = licence(s.code); const list = products.get(key); if (list) list.push(s); else products.set(key, [s]);
  }
  const paid = (s: Scored) => status(s.entry, day).paid;
  const ranked = [...products.values()].map(list => {
    const live = list.filter(paid); const best = (of: Scored[]) => Math.max(...of.map(s => s.score));
    return { list, score: best(list), live, paidScore: live.length ? best(live) : -Infinity };
  }).sort((a, b) => b.score - a.score || b.paidScore - a.paidScore);
  // The chosen code and its product first, then the best of the rest, for a person to compare.
  const shown = (first?: string) => [...ranked].sort((a, b) => Number(b.list.some(s => s.code === first)) - Number(a.list.some(s => s.code === first))).slice(0, 5)
    .flatMap(p => [...p.list].sort((a, b) => Number(b.code === first) - Number(a.code === first) || b.score - a.score || Number(paid(b)) - Number(paid(a)) || a.code.localeCompare(b.code)))
    .slice(0, 8).map(({ code, score, why }) => ({ code, score, why }));
  const top = ranked[0];
  if (!top || top.score < THRESHOLD) return { kind: 'none', candidates: shown() };
  const best = ranked.filter(p => p.live.length).sort((a, b) => b.paidScore - a.paidScore)[0];
  if (best && best.paidScore >= THRESHOLD && best.paidScore > top.score - MARGIN) {
    if (ranked.some(p => p !== best && p.live.length && p.paidScore > best.paidScore - MARGIN)) return { kind: 'ambiguous', candidates: shown() };
    let chosen = best.live.filter(s => s.score === best.paidScore);
    if (chosen.length > 1 && name.pack) { const preferred = chosen.filter(s => s.code.endsWith(name.pack!)); if (preferred.length) chosen = preferred; }
    if (chosen.length > 1) return { kind: 'codes', candidates: shown() };
    // The store's [廠牌] tag names someone else: the name agrees, but a person should look.
    if (chosen[0].why.includes('廠牌不符')) return { kind: 'maker', candidates: shown(chosen[0].code) };
    return { kind: 'clear', code: chosen[0].code, candidates: shown(chosen[0].code) };
  }
  if (ranked.some(p => p !== top && p.score > top.score - MARGIN)) return { kind: 'ambiguous', candidates: shown() };
  return { kind: 'unpaid', candidates: shown() };
}
