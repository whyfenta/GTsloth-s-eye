import './review.css';
import { REVIEW_CATALOG, REVIEW_ENDPOINT, REVIEW_PROPOSALS } from './review-config';
import { createDeck } from './review-deck';
import { publishedProposals, type Proposal } from './rx-proposals';
import { CATALOG_FORMAT, CHOICES, MAX_LINKS, PROPOSAL_LABEL, cleanName, closed, done, linkLabel, linksText, mergeVotes, parseLinks, preReviewer, proposalItem, reviewerId, splitVotes, stale, tally,
  teamState, teamStatus, voteRequest, withLinks, type Catalog, type Chip, type Choice, type Item, type Link, type Reviewer, type TeamState, type TeamStatus, type Vote, type Votes } from './review-model';

// The pharmacists' review page. The rule catalog comes with the site (public/assets/rx/review.json, written by
// npm run rx-review-page); the team's votes and the weekly proposals come from the team's sheet (docs/rx-review-apps-script.gs),
// reached only with the team code in the shared link. Without a sheet or a code the page still works for one reviewer: the
// decisions stay in this browser and can be copied out.
const TABLES: [string, string][] = [['all', '全部'], ['proposals', '提案'], ['indications', '適應症'], ['co', '同處方'], ['cautions', '注意事項'],
  ['specialty', '科別常用'], ['classes', '藥品分類'], ['settings', '設定'], ['questions', '待決定']];
const FILTERS: [string, string][] = [['todo', '我的待審'], ['all', '全部'], ['split', '有分歧'], ['agreed', '達門檻'], ['attention', '需特別注意'], ['closed', '已結案'], ['retired', '已刪除']];
const KEYS = { me: 'gtsloth-review-me', code: 'gtsloth-review-code', votes: 'gtsloth-review-votes', mode: 'gtsloth-review-mode' };
const POLL = 60_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
const read = <T>(key: string): T | undefined => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined; } catch { return undefined; } };
const keep = (key: string, value: unknown): boolean => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

let catalog: Catalog | undefined;
let items: Item[] = [];
let haystack: Record<string, string> = {};
let batchOrder: Record<string, number> = {};
let team: TeamState | undefined;
/** The open proposals that came with the site; the team's sheet may know newer ones. */
let published: Proposal[] = [];
let mine: Votes = read<Votes>(KEYS.votes) ?? {};
/** Items whose vote has not reached the sheet yet. */
const pending = new Set<string>();
let me: Reviewer = { id: '', name: '', ...read<Partial<Reviewer>>(KEYS.me) };
if (!/^[0-9a-z]{16}$/.test(me.id)) { me = { id: reviewerId(), name: cleanName(me.name ?? '') }; keep(KEYS.me, me); }
type Mode = 'deck' | 'list';
const savedMode = read<Mode>(KEYS.mode);
/** Phones open in card mode (one card at a time, a small stack a day); the reviewer's own choice is remembered. */
const view = { table: 'all', filter: 'todo', batch: '', q: '',
  mode: (savedMode === 'deck' || savedMode === 'list' ? savedMode : matchMedia('(max-width: 640px), (pointer: coarse)').matches ? 'deck' : 'list') as Mode };
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving = false, renderLater = false, stored = true;

// The team code arrives in the shared link once, then stays in this browser and leaves the address bar.
const params = new URLSearchParams(location.search);
const linked = params.get('code');
if (linked && /^[0-9A-Za-z]{12,40}$/.test(linked)) {
  keep(KEYS.code, linked);
  params.delete('code');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
}
const code = read<string>(KEYS.code) ?? '';
const shared = !!REVIEW_ENDPOINT && !!code;

const codes = (spec: string | undefined) => String(spec ?? '').split(/\s+/).filter(Boolean);
const rocDate = (id: string) => { const m = /^(\d{4})-?(\d\d)-?(\d\d)/.exec(id); return m ? `${Number(m[1]) - 1911}/${m[2]}/${m[3]}` : ''; };
const quorum = () => team?.quorum ?? 2;
const allVotesOn = (id: string): Record<string, Vote> => ({ ...team?.votes[id], ...(mine[id] ? { [me.id]: mine[id] } : {}) });
const isPre = (id: string) => preReviewer(id === me.id ? me.name : team?.reviewers[id]);
/** The pharmacists' votes on an item: these decide where the team stands. */
const votesOn = (id: string) => splitVotes(allVotesOn(id), isPre).team;
/** The AI pre-reviews on an item that still apply: shown apart, never counted. */
const preShownOn = (item: Item) => Object.entries(splitVotes(allVotesOn(item.id), isPre).pre).filter(([, vote]) => !stale(item, vote) && (vote.d || vote.c.trim() || vote.l?.length));
const nameOf = (id: string) => id === me.id ? (me.name || '你') : team?.reviewers[id] || '另一位審核者';
const statusOf = (item: Item): TeamStatus => teamStatus(item, votesOn(item.id), quorum());
/** The team's sheet runs a script from before evidence links: what is typed in the box would be lost, so it is not offered. */
const linksOff = () => shared && !!team && !team.linksSaved;
/** Evidence links as short labels, each opening the full address in a new tab. */
function linkRow(links: Link[] | undefined) {
  const box = el('div', 'vlinks');
  for (const link of links ?? []) {
    const a = el('a', '', linkLabel(link));
    a.href = link.u; a.title = link.u; a.target = '_blank'; a.rel = 'noopener noreferrer';
    box.append(a);
  }
  return box;
}
const linksLine = (links: Link[] | undefined) => (links ?? []).map(link => link.t ? `${link.t} ${link.u}` : link.u).join(' ');

/** One line per ATC code: the code, its Chinese class name, then the ingredients (brand seen in the samples). C08@HS counts only at bedtime. */
function drugList(spec: string | undefined, max = 6) {
  const box = el('div', 'drugs');
  for (const token of codes(spec)) {
    const [atc, frequency] = token.split('@');
    const info = catalog?.atc[atc] ?? { zh: '', ex: [], n: 0 };
    const row = el('div', 'drug');
    row.append(el('code', 'atc', atc));
    if (frequency) row.append(el('span', 'badge', `頻率含 ${frequency}`), ' ');
    if (info.zh) row.append(el('b', '', info.zh));
    if (!info.n) row.append(el('span', 'none', '健保藥品檔中沒有這個 ATC 的藥'));
    else { const shown = info.ex.slice(0, max); row.append(el('span', 'ex', shown.join('、') + (info.n > shown.length ? ` 等 ${info.n} 種成分` : ''))); }
    box.append(row);
  }
  return box;
}
const drugText = (spec: string) => codes(spec).map(token => { const info = catalog?.atc[token.split('@')[0]]; return info ? `${info.zh} ${info.ex.join(' ')}` : ''; }).join(' ');
function dxChips(list: Chip[] = []) {
  const box = el('div', 'dx');
  for (const chip of list) { const span = el('span'); span.append(el('code', '', chip.t)); if (chip.zh) span.append(chip.zh); box.append(span); }
  return box;
}
function field(label: string, content: string | Node) {
  const row = el('div', 'field');
  const body = el('div');
  body.append(content);
  row.append(el('span', '', label), body);
  return row;
}
const basisBadge = (basis: string) => el('span', /^仿單/.test(basis) ? 'badge b-label b-wrap' : basis === '常見仿單外' ? 'badge b-off' : 'badge b-wrap', basis);
function hitsText(item: Item): string {
  if (item.hits == null) return '';
  const n = item.hits;
  switch (item.table) {
    case 'indications': case 'co': return n ? `樣本中解釋 ${n} 個藥` : '樣本中未用到';
    case 'cautions': return n ? `樣本中觸發 ${n} 次` : '樣本中未觸發';
    case 'specialty': return n ? `樣本中以科別解釋 ${n} 個藥` : '樣本中未用到';
    case 'classes': return item.kind === '低風險' ? (n ? `不提示 ${n} 個藥` : '樣本中未用到') : (n ? `判為黃色 ${n} 個藥` : '樣本中沒有判為黃色');
    case 'settings': return item.name === '同成分重複' ? `樣本中出現 ${n} 次` : `這一層解釋了 ${n} 個藥`;
  }
  return '';
}
function headline(item: Item): string {
  switch (item.table) {
    case 'indications': return item.cls ?? '';
    case 'co': return '可由同處方的藥解釋';
    case 'cautions': return item.msg ?? '';
    case 'specialty': return `${item.name}常開的藥`;
    case 'classes': return `${item.kind}：${item.desc}`;
    case 'settings': return `${item.name}（目前：${item.value}）`;
    default: return item.title ?? '';
  }
}
const condText = (cond: NonNullable<Item['conds']>[number]) => cond.kind === '診斷' ? (cond.dx ?? []).map(chip => chip.t).join(' ') : cond.kind === '同處方' ? cond.atc ?? '' : cond.text ?? '';
function summary(item: Item): string {
  switch (item.table) {
    case 'indications': return `${item.atc} ${item.cls}：${(item.icd ?? []).map(chip => chip.t).join(' ')}（${item.basis}）`;
    case 'co': return `${item.atc} 可由同處方 ${item.partners} 解釋（${item.basis}）`;
    case 'cautions': return `${item.id} ${item.atc || item.keyword} ${(item.conds ?? []).map(cond => `${cond.kind} ${condText(cond)}`).join('＋')} → ${item.level}：${item.msg}`;
    case 'specialty': return `${item.dept} ${item.name}：${item.atc}`;
    case 'classes': return `${item.atc} ${item.kind}：${item.desc}`;
    case 'settings': return `${item.name}＝${item.value}（可選：${item.options}）`;
    case 'proposals': return `${item.kind}：${item.title}${item.row ? `〔${item.file}.csv：${item.row}〕` : ''}`;
    default: return item.title ?? '';
  }
}
const attention = (item: Item) => item.flags.length > 0 || item.basis === '常見仿單外' || item.table === 'settings' || item.table === 'questions';
function searchText(item: Item): string {
  const conds = item.conds ?? [];
  const drugs = drugText([item.atc, item.partners, ...conds.map(cond => cond.atc ?? '')].join(' '));
  const dx = [...item.icd ?? [], ...conds.flatMap(cond => cond.dx ?? [])];
  return [item.id, summary(item), item.note, item.ref, item.desc, item.why, item.evidence, dx.map(chip => chip.zh).join(' '), drugs].join(' ').toLowerCase();
}
const conditionWords = (cond: NonNullable<Item['conds']>[number]): string | Node => {
  const text = cond.text ?? '';
  if (cond.kind === '診斷') return dxChips(cond.dx);
  if (cond.kind === '同處方') return drugList(cond.atc);
  if (cond.kind === '年齡') return text.startsWith('<') ? `未滿 ${text.slice(1)} 歲` : `${text.replace('>=', '')} 歲以上`;
  if (cond.kind === '性別') return `${text}性`;
  if (cond.kind === '腎功能') return `腎絲球過濾率（eGFR）低於 ${text.replace('<', '')}（依慢性腎病分期的診斷判斷）`;
  if (cond.kind === '未同處方') return text.startsWith('=') ? `同處方沒有健保碼 ${text.slice(1)} 的品項` : drugList(text);
  if (cond.kind === '同類數') { const [count, ...atcs] = codes(text); const box = el('div'); box.append(`同處方有 ${count.replace('>=', '')} 種以上屬於下列類別的藥：`, drugList(atcs.join(' '), 3)); return box; }
  return text;
};

function buildCard(item: Item) {
  const card = el('article', 'card');
  card.id = `card-${item.id}`;
  const head = el('div', 'head');
  head.append(el('span', 'rid', item.id), el('span', 'state'));
  if (item.table === 'cautions') head.append(el('span', `lv lv-${item.level}`, item.level));
  if (item.table === 'specialty') head.append(el('span', 'atc', item.dept));
  if (item.table === 'proposals') head.append(el('span', 'badge', `提案・${item.kind}`));
  head.append(el('span', 'title', headline(item)), basisBadge(item.basis));
  const hits = hitsText(item);
  if (hits) head.append(el('span', `hits${item.hits ? '' : ' zero'}`, hits));
  card.append(head);

  if (item.why) card.append(el('p', 'why', item.why));
  if (item.prev) card.append(el('p', 'prev', `這條改過。原本：${item.prev}`));
  if (item.table === 'indications' || item.table === 'co' || item.table === 'classes') card.append(field('藥品', drugList(item.atc)));
  if (item.table === 'indications') card.append(field('可解釋的診斷', dxChips(item.icd)));
  if (item.table === 'co') card.append(field('同處方的藥', drugList(item.partners)));
  if (item.table === 'cautions') {
    card.append(field('藥品', item.atc ? drugList(item.atc) : `成分含「${item.keyword}」`));
    if (item.atc && item.keyword) card.append(field('或成分含', item.keyword));
    (item.conds ?? []).forEach((cond, n) => card.append(field(`${n ? '且' : '條件'}（${cond.kind}）`, conditionWords(cond))));
  }
  if (item.table === 'specialty') card.append(field('常開的藥', drugList(item.atc, 3)));
  if (item.table === 'settings') card.append(field('可選的值', item.options ?? ''), field('說明', item.desc ?? ''));
  if (item.table === 'questions') card.append(field('說明', item.desc ?? ''));
  if (item.table === 'proposals') {
    if (item.row) card.append(field(`${item.file}.csv`, el('code', '', item.row)));
    if (item.evidence) card.append(field('證據', item.evidence));
    if (item.trial) card.append(field('試跑結果', item.trial));
  }
  if (item.note) card.append(field(item.table === 'proposals' ? '說明' : '備註', item.note));
  if (item.ref) card.append(field('參考方向', `${item.ref}（待核對）`));
  const links = (item.links ?? []).filter(link => /^https:\/\//.test(link.u));
  if (links.length) {
    const box = el('div', 'links');
    for (const link of links) { const a = el('a', '', link.t); a.href = link.u; a.target = '_blank'; a.rel = 'noopener noreferrer'; box.append(a); }
    card.append(field('出處', box));
  }
  if (item.flags.length) { const box = el('div', 'flags'); for (const flag of item.flags) box.append(el('div', 'flag', flag)); card.append(box); }
  if (item.outcome) { const p = el('p', 'outcome'); p.append(el('b', '', '處理結果：'), item.outcome); card.append(p); }
  if (item.approved) { const p = el('p', 'outcome'); p.append(el('b', '', '已結案：'), `${rocDate(item.approved.at)} ${item.approved.n} 位審核者同意，照原樣保留。`); card.append(p); }

  const decide = el('div', 'decide');
  decide.append(el('div', 'votes'), el('div', 'opinions'), el('div', 'prereview'));
  if (!closed(item)) {
    const choices = el('div', 'choices');
    for (const value of CHOICES) {
      const button = el('button', 'choice', item.table === 'proposals' ? PROPOSAL_LABEL[value] : value);
      button.type = 'button'; button.dataset.v = value; button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => choose(item, mine[item.id]?.d === value ? '' : value));
      choices.append(button);
    }
    const clear = el('button', 'clear', '清除');
    clear.type = 'button'; clear.hidden = true;
    clear.addEventListener('click', () => choose(item, '', true));
    choices.append(clear);
    const comment = el('textarea', 'comment');
    comment.rows = 1; comment.maxLength = 1000;
    comment.placeholder = '意見（不同意或其他意見時，請寫原因或要怎麼改）';
    comment.setAttribute('aria-label', `${item.id} 的意見`);
    comment.addEventListener('input', () => remark(item, comment.value));
    const evidence = el('textarea', 'comment linkbox');
    evidence.rows = 1; evidence.maxLength = 6000;
    evidence.setAttribute('aria-label', `${item.id} 的證據連結`);
    const hint = el('p', 'linkhint');
    hint.setAttribute('aria-live', 'polite');
    evidence.addEventListener('input', () => attach(item, evidence.value));
    decide.append(choices, comment, evidence, hint);
  }
  card.append(decide);
  return card;
}
function updateCard(item: Item) {
  const card = document.getElementById(`card-${item.id}`);
  if (!card) return;
  const vote = mine[item.id];
  card.dataset.d = vote?.d ?? '';
  const pill = card.querySelector('.state')!;
  const finished = done(item, vote), again = stale(item, vote);
  pill.className = `state ${finished ? 's-done' : again ? 's-again' : 's-todo'}`;
  pill.textContent = closed(item) ? '已結案' : finished ? '你已審' : again ? '內容已改，請重審' : '待你審';
  for (const button of card.querySelectorAll<HTMLButtonElement>('.choice')) button.setAttribute('aria-pressed', String(button.dataset.v === vote?.d));
  const clear = card.querySelector<HTMLButtonElement>('.clear');
  if (clear) clear.hidden = !vote?.d && !vote?.c?.trim() && !vote?.l?.length;
  const comment = card.querySelector<HTMLTextAreaElement>('.comment:not(.linkbox)');
  if (comment && document.activeElement !== comment && comment.value !== (vote?.c ?? '')) comment.value = vote?.c ?? '';
  const evidence = card.querySelector<HTMLTextAreaElement>('.linkbox');
  if (evidence) {
    const off = linksOff() && !vote?.l?.length;
    evidence.disabled = off;
    evidence.placeholder = off ? '證據連結：負責人更新試算表的指令碼後才能存' : `證據連結（選填，一行一個，最多 ${MAX_LINKS} 個）：說明 https://…，例如「仿單 https://…」`;
    if (document.activeElement !== evidence && linksText(parseLinks(evidence.value).links) !== linksText(vote?.l)) evidence.value = linksText(vote?.l);
    linkHint(card, evidence.value);
  }

  const counted = tally(item, votesOn(item.id));
  const label = (value: Choice) => item.table === 'proposals' ? PROPOSAL_LABEL[value] : value;
  const votes = card.querySelector('.votes')!;
  votes.replaceChildren();
  const status = statusOf(item);
  if (!closed(item)) { const chip = el('span', 'teamstate', status === '達門檻' ? `達門檻（${quorum()} 位同意），等負責人結案` : status === '有分歧' ? '有分歧，等負責人決定' : status === '審核中' ? `審核中（門檻 ${quorum()} 位）` : '還沒有人審'); chip.dataset.s = status; votes.append(chip); }
  for (const [value, cls] of [['同意', 'v-yes'], ['不同意', 'v-no'], ['其他意見', 'v-other']] as [Choice, string][]) {
    if (!counted[value].length) continue;
    const span = el('span', cls);
    span.append(el('b', '', `${label(value)} ${counted[value].length}`), `（${counted[value].map(nameOf).join('、')}）`);
    votes.append(span);
  }
  const opinions = card.querySelector('.opinions')!;
  opinions.replaceChildren();
  for (const opinion of counted.comments) {
    if (opinion.who === me.id && !closed(item)) continue;
    const row = el('div');
    row.append(el('b', '', `${nameOf(opinion.who)}${opinion.d ? `（${label(opinion.d)}）` : ''}${opinion.c ? '：' : ''}`), opinion.c);
    if (opinion.l?.length) row.append(linkRow(opinion.l));
    opinions.append(row);
  }
  const pre = card.querySelector('.prereview')!;
  pre.replaceChildren();
  const preShown = preShownOn(item);
  if (preShown.length) pre.append(el('p', 'pre-head', 'AI 預審（非藥師簽核，不計入門檻與分歧）'));
  for (const [who, { d, c, l }] of preShown) {
    const row = el('div');
    row.append(el('b', '', `${nameOf(who)}${d ? `（${label(d)}）` : ''}${c.trim() ? '：' : ''}`), c.trim());
    if (l?.length) row.append(linkRow(l));
    pre.append(row);
  }
}

function visible(item: Item): boolean {
  if (view.table !== 'all' && item.table !== view.table) return false;
  if (view.batch && item.batch !== view.batch) return false;
  const status = statusOf(item);
  if (view.filter === 'todo' && done(item, mine[item.id])) return false;
  if (view.filter === 'split' && status !== '有分歧') return false;
  if (view.filter === 'agreed' && status !== '達門檻') return false;
  if (view.filter === 'closed' && status !== '已結案') return false;
  if (view.filter === 'attention' && !attention(item)) return false;
  if (view.q && !haystack[item.id].includes(view.q)) return false;
  return true;
}
/** Proposals first, then the newest batch, in table order within a batch. */
function listOrder(): Item[] {
  const order = new Map(items.map((item, n) => [item.id, n]));
  const rank = (item: Item) => item.table === 'proposals' ? Infinity : batchOrder[item.batch] ?? -1;
  return [...items].sort((a, b) => rank(b) - rank(a) || order.get(a.id)! - order.get(b.id)!);
}
function renderList() {
  renderLater = false;
  const list = $('list');
  list.replaceChildren();
  // In card mode the card being read is the only one on the page.
  if (view.mode === 'deck') return;
  if (!catalog) { list.append(el('p', 'empty', '正在讀取規則清單…')); return; }
  if (view.filter === 'retired') {
    const gone = catalog.retired.filter(rule => !view.q || `${rule.id} ${rule.text} ${rule.outcome ?? ''}`.toLowerCase().includes(view.q));
    for (const rule of gone) {
      const card = el('article', 'card'), head = el('div', 'head');
      head.append(el('span', 'rid', rule.id), el('span', 'state s-done', '已刪除'), el('span', 'title', rule.text));
      card.append(head);
      if (rule.outcome) { const p = el('p', 'outcome'); p.append(el('b', '', '處理結果：'), rule.outcome); card.append(p); }
      list.append(card);
    }
    if (!gone.length) list.append(el('p', 'empty', '沒有已刪除的規則。'));
    return;
  }
  const shown = listOrder().filter(visible);
  for (const item of shown) { list.append(buildCard(item)); updateCard(item); }
  if (!shown.length) list.append(el('p', 'empty', view.filter === 'todo' && !view.q ? '這個分類沒有等你審的項目了。新條文與新提案加入時會自動出現在這裡。' : '沒有符合條件的項目。換一個分類或清除搜尋試試。'));
}
function renderCounts() {
  if (!catalog) return;
  const count: Record<TeamStatus, number> = { 已結案: 0, 達門檻: 0, 有分歧: 0, 審核中: 0, 未審: 0 };
  for (const item of items) count[statusOf(item)]++;
  const todo = items.filter(item => !done(item, mine[item.id])).length;
  $('todo').textContent = `我的待審 ${todo} 條`;
  $('c-closed').textContent = String(count.已結案); $('c-agreed').textContent = String(count.達門檻); $('c-split').textContent = String(count.有分歧);
  $('c-going').textContent = String(count.審核中); $('c-none').textContent = String(count.未審);
  const width = (n: number) => `${items.length ? n / items.length * 100 : 0}%`;
  $('m-closed').style.width = width(count.已結案); $('m-agreed').style.width = width(count.達門檻); $('m-split').style.width = width(count.有分歧); $('m-going').style.width = width(count.審核中);
  for (const button of $('tabs').children as HTMLCollectionOf<HTMLButtonElement>) {
    const set = items.filter(item => button.dataset.t === 'all' || item.table === button.dataset.t);
    const open = set.filter(item => !done(item, mine[item.id])).length;
    button.textContent = open ? `${button.dataset.label} ${open} 待審` : `${button.dataset.label} ${set.length}`;
  }
  for (const button of $('batches').querySelectorAll<HTMLButtonElement>('.chipbtn')) {
    const set = items.filter(item => item.batch === button.dataset.b && item.table !== 'proposals');
    button.textContent = `${button.dataset.label} ${set.filter(item => !done(item, mine[item.id])).length}／${set.length}`;
  }
  renderLatest();
  renderTeam();
  if (view.mode === 'deck') deck.panel();
}
function renderLatest() {
  const box = $('latest');
  const batch = catalog?.batches.at(-1);
  if (!batch) { box.hidden = true; return; }
  const set = items.filter(item => item.batch === batch.id && item.table !== 'proposals');
  const text = el('div');
  text.append(el('p', '', `最新一批：${batch.title}（${rocDate(batch.id)}）${set.length} 條，${set.filter(item => !done(item, mine[item.id])).length} 條等你審`));
  if (batch.note) text.append(el('p', 'sub', batch.note));
  const go = el('button', 'action', view.batch === batch.id ? '看全部批次' : '只看這批');
  go.type = 'button';
  go.addEventListener('click', () => setBatch(view.batch === batch.id ? '' : batch.id));
  box.replaceChildren(text, go);
  box.hidden = false;
}
/** Who is reviewing, and how many of the open items each has decided. */
function renderTeam() {
  const box = $('team');
  const open = items.filter(item => !closed(item));
  const people = new Set([...Object.keys(team?.reviewers ?? {}), ...(Object.keys(mine).length ? [me.id] : [])]);
  if (!shared || !people.size) { box.hidden = true; return; }
  box.replaceChildren(el('span', '', `團隊（結案門檻：${quorum()} 位同意且無人反對）：`));
  // Pharmacists first; AI pre-reviews after them, marked as not counted.
  for (const id of [...people].sort((a, b) => Number(isPre(a)) - Number(isPre(b)))) {
    const decided = open.filter(item => { const vote = allVotesOn(item.id)[id]; return vote?.d && !stale(item, vote); }).length;
    const span = el('span');
    span.append(el('b', '', nameOf(id)), ` ${decided}／${open.length}${isPre(id) ? '（AI 預審，不計票）' : ''}`);
    box.append(span);
  }
  box.hidden = false;
}
function setBatch(id: string) {
  view.batch = id;
  for (const button of $('batches').querySelectorAll<HTMLButtonElement>('.chipbtn')) button.setAttribute('aria-pressed', String(button.dataset.b === id));
  renderLatest();
  renderList();
}
const say = (text: string, warn = false) => { const node = $('status'); node.textContent = text; node.classList.toggle('warn', warn); deck.status(text, warn); };
const sayStore = (text: string, warn = false) => { const node = $('store'); node.textContent = text; node.classList.toggle('warn', warn); };

/** Takes back a decision made in card mode. Sent as a new change, so the sheet's copy of the decision does not win over it. */
function restore(item: Item, before: Vote | undefined) {
  const d = before?.d && !stale(item, before) ? before.d : '';
  mine = { ...mine, [item.id]: { d, c: before?.c ?? '', t: new Date().toISOString(), ...withLinks(before?.l) } };
  changed(item);
}
function choose(item: Item, value: Choice | '', wipe = false) {
  if (shared && !me.name) { needName(); return; }
  const vote: Vote = { d: value, c: wipe ? '' : mine[item.id]?.c ?? '', t: new Date().toISOString(), ...(wipe ? {} : withLinks(mine[item.id]?.l)) };
  mine = { ...mine, [item.id]: vote };
  changed(item);
}
function remark(item: Item, text: string) {
  if (shared && !me.name) { needName(); return; }
  const before = mine[item.id];
  // A comment alone does not count as a new decision on a rule that changed since.
  const t = before?.d && stale(item, before) ? before.t : new Date().toISOString();
  mine = { ...mine, [item.id]: { d: before?.d ?? '', c: text, t, ...withLinks(before?.l) } };
  changed(item, true);
}
/** The evidence box changed: its proper links are kept with the vote, like a comment (not a new decision on a changed rule). */
function attach(item: Item, text: string) {
  if (shared && !me.name) { needName(); return; }
  const before = mine[item.id];
  const { links } = parseLinks(text);
  const card = document.getElementById(`card-${item.id}`);
  if (card) linkHint(card, text);
  if (linksText(links) === linksText(before?.l)) return;
  const t = before?.d && stale(item, before) ? before.t : new Date().toISOString();
  mine = { ...mine, [item.id]: { d: before?.d ?? '', c: before?.c ?? '', t, ...withLinks(links) } };
  changed(item, true);
}
/** Under the evidence box: which lines will not be kept, and why. */
function linkHint(card: HTMLElement, text: string) {
  const hint = card.querySelector('.linkhint');
  if (!hint) return;
  const { links, bad } = parseLinks(text);
  hint.textContent = !bad ? '' : links.length >= MAX_LINKS ? `最多存 ${MAX_LINKS} 個連結，另外 ${bad} 行不會存` : `有 ${bad} 行不會存：每行要以 https:// 開頭的網址結尾，前面可寫簡短說明`;
  hint.classList.toggle('warn', !!bad);
}
function changed(item: Item, typing = false) {
  stored = keep(KEYS.votes, mine);
  pending.add(item.id);
  updateCard(item);
  renderCounts();
  clearTimeout(saveTimer);
  if (shared) { say('尚未存檔…'); saveTimer = setTimeout(() => { void save(); }, typing ? 1200 : 400); }
  else say(stored ? '已存在這個瀏覽器（只有這台裝置看得到），請按「複製我的審核結果」交給負責人' : '這個瀏覽器無法存檔，請按「複製我的審核結果」保存', true);
}
function needName() {
  $('me').dataset.need = 'name';
  sayStore('請先填你的名字再開始審核，團隊成員才知道是誰的決定。', true);
  $<HTMLInputElement>('name').focus();
}

/** Sends the votes the sheet does not have yet; what could not be sent waits for the next change or the next read. */
async function save() {
  if (!shared || saving || !pending.size || !me.name) return;
  saving = true;
  const ids = [...pending].slice(0, 200);
  const sent = Object.fromEntries(ids.map(id => [id, mine[id]]));
  try {
    const response = await fetch(REVIEW_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(voteRequest(code, me, sent)) });
    const answer = await response.json() as { ok?: boolean; error?: string };
    if (!answer.ok) throw new Error(answer.error === 'code' ? '團隊代碼不對，請用負責人分享的連結重新開啟' : `儲存空間拒收（${answer.error ?? '不明原因'}）`);
    for (const id of ids) if (mine[id] === sent[id]) pending.delete(id);
    say(`已存檔 ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`);
  } catch (error) {
    say(`存檔失敗，稍後會再試（決定仍留在這個瀏覽器）：${error instanceof Error && /^(團隊|儲存)/.test(error.message) ? error.message : '連不上團隊共用儲存'}`, true);
  } finally {
    saving = false;
    if (pending.size) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void save(); }, 15_000); }
  }
}
/** Reads everyone's votes and the proposals; this reviewer's own votes are merged, the later one standing. */
async function load(first = false) {
  if (!shared) return;
  try {
    const response = await fetch(`${REVIEW_ENDPOINT}?code=${encodeURIComponent(code)}&at=${Date.now()}`);
    const state = teamState(await response.json());
    if ('error' in state) { sayStore(`${state.error}：請用負責人分享的完整連結重新開啟。決定暫時只存在這個瀏覽器。`, true); return; }
    team = state;
    const remote = Object.fromEntries(Object.entries(state.votes).flatMap(([id, byReviewer]) => byReviewer[me.id] ? [[id, byReviewer[me.id]]] : []));
    const merged = mergeVotes(mine, remote);
    for (const [id, vote] of Object.entries(mine)) if (!remote[id] || remote[id].t < vote.t) pending.add(id);
    mine = merged;
    keep(KEYS.votes, mine);
    if (!me.name && state.reviewers[me.id]) { me.name = state.reviewers[me.id]; keep(KEYS.me, me); $<HTMLInputElement>('name').value = me.name; }
    const notes = [`${Object.keys(state.reviewers).length} 位審核者`, `提案 ${new Set([...published, ...state.proposals].map(proposal => proposal.id)).size} 項`];
    if (state.skipped) notes.push(`另有 ${state.skipped} 項提案格式不對，沒有顯示`);
    if (state.proposalProblem) notes.push(`最新的提案表讀不到（${state.proposalProblem}），目前顯示隨網站發布的提案；請負責人在 Apps Script 執行 checkProposals`);
    sayStore(`已連上團隊共用儲存：${notes.join('；')}。`, !!state.proposalProblem);
    applyItems();
    if (view.mode === 'deck') deck.refresh();
    else if (first || !document.activeElement?.classList.contains('comment')) renderList(); else { renderLater = true; for (const item of items) updateCard(item); }
    renderCounts();
    if (pending.size) void save();
  } catch {
    sayStore('連不上團隊共用儲存，決定暫時只存在這個瀏覽器，連上後會自動送出。', true);
  }
}
/** The catalog's rules with the proposals: open ones from the team's sheet, closed ones as the repo records them. */
function applyItems() {
  if (!catalog) return;
  const closedProposals = new Map((catalog.proposals ?? []).map(proposal => [proposal.id, proposal]));
  const known = new Map([...published, ...team?.proposals ?? []].map(proposal => [proposal.id, proposal]));
  const week = (proposal: Proposal) => proposal.id.slice(1, 9);
  const open = [...known.values()].sort((a, b) => week(b).localeCompare(week(a)) || a.id.localeCompare(b.id)).map(proposal => proposalItem(proposal, closedProposals.get(proposal.id)));
  const listed = new Set(open.map(item => item.id));
  const past = [...closedProposals.values()].filter(proposal => !listed.has(proposal.id))
    .map(proposal => proposalItem({ id: proposal.id, kind: '待決定', title: proposal.title, file: '', row: '', evidence: '', basis: '提案', trial: '', note: '' }, proposal));
  items = [...open, ...past, ...catalog.items];
  haystack = Object.fromEntries(items.map(item => [item.id, searchText(item)]));
}

const deck = createDeck({
  items: listOrder, mine: () => mine, me: () => me.id, allVotesOn, teamVotesOn: votesOn, hasPre: item => preShownOn(item).length > 0,
  quorum, atc: () => catalog?.atc ?? {}, buildCard, updateCard,
  ready: () => { if (shared && !me.name) { needName(); return false; } return true; },
  agree: item => choose(item, '同意'), restore,
}, $('deck'));
function setMode(mode: Mode, remember = false) {
  view.mode = mode;
  if (remember) keep(KEYS.mode, mode);
  document.body.classList.toggle('deck-mode', mode === 'deck');
  $('deck').hidden = mode !== 'deck';
  $('mode').textContent = mode === 'deck' ? '清單模式' : '卡片模式';
  $('mode').title = mode === 'deck' ? '改成一次看全部規則的清單' : '改成一次一張的卡片，每天一小疊';
  renderList();
  if (catalog && mode === 'deck') deck.show();
}
function setupBar() {
  $('mode').addEventListener('click', () => { setMode(view.mode === 'deck' ? 'list' : 'deck', true); scrollTo({ top: 0 }); });
  for (const [table, label] of TABLES) {
    const button = el('button', 'tab', label);
    button.type = 'button'; button.dataset.t = table; button.dataset.label = label;
    button.setAttribute('aria-pressed', String(view.table === table));
    button.addEventListener('click', () => { view.table = table; for (const other of $('tabs').children) other.setAttribute('aria-pressed', String((other as HTMLElement).dataset.t === table)); renderList(); });
    $('tabs').append(button);
  }
  for (const [filter, label] of FILTERS) {
    const button = el('button', 'chipbtn', label);
    button.type = 'button'; button.dataset.f = filter;
    button.setAttribute('aria-pressed', String(view.filter === filter));
    button.addEventListener('click', () => { view.filter = filter; for (const other of $('filters').children) other.setAttribute('aria-pressed', String((other as HTMLElement).dataset.f === filter)); renderList(); });
    $('filters').append(button);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  $<HTMLInputElement>('search').addEventListener('input', event => {
    clearTimeout(timer);
    timer = setTimeout(() => { view.q = (event.target as HTMLInputElement).value.trim().toLowerCase(); renderList(); }, 150);
  });
  const label = Object.fromEntries(TABLES);
  const copy = async (lines: string[][], what: string) => {
    const text = lines.map(line => line.map(value => value.replace(/\s+/g, ' ')).join('\t')).join('\n');
    try { await navigator.clipboard.writeText(text); say(`已複製 ${lines.length - 1} 項${what}`); }
    catch {
      const area = el('textarea', 'comment'); area.value = text; area.rows = 6;
      $('foot').replaceChildren(el('p', '', '瀏覽器不允許直接複製，請全選下面的文字後複製：'), area);
      area.focus(); area.select();
    }
  };
  $('copy-mine').addEventListener('click', () => {
    const lines = [['編號', '規則表', '規則', '決定', '意見', '狀態', '證據連結']];
    for (const item of items) { const vote = mine[item.id]; if (vote) lines.push([item.id, label[item.table], summary(item), vote.d, vote.c, done(item, vote) ? '已審' : stale(item, vote) ? '內容已改' : '待審', linksLine(vote.l)]); }
    void copy(lines, '審核結果');
  });
  $('copy-team').addEventListener('click', () => {
    const lines = [['編號', '規則表', '規則', '團隊狀態', '同意', '不同意', '其他意見', '意見', 'AI 預審（不計票）', '證據連結']];
    for (const item of items) {
      if (closed(item)) continue;
      const counted = tally(item, votesOn(item.id));
      const pre = preShownOn(item);
      if (!counted.同意.length && !counted.不同意.length && !counted.其他意見.length && !counted.comments.length && !pre.length) continue;
      lines.push([item.id, label[item.table], summary(item), statusOf(item), counted.同意.map(nameOf).join('、'), counted.不同意.map(nameOf).join('、'), counted.其他意見.map(nameOf).join('、'),
        counted.comments.filter(opinion => opinion.c).map(opinion => `${nameOf(opinion.who)}：${opinion.c}`).join(' ／ '),
        pre.map(([who, vote]) => `${nameOf(who)}${vote.d ? `（${vote.d}）` : ''}：${vote.c.trim()}`).join(' ／ '),
        [...counted.comments.map(opinion => [opinion.who, opinion.l] as const), ...pre.map(([who, vote]) => [who, vote.l] as const)]
          .filter(([, links]) => links?.length).map(([who, links]) => `${nameOf(who)}：${linksLine(links)}`).join(' ／ ')]);
    }
    void copy(lines, '團隊統計');
  });
  const name = $<HTMLInputElement>('name');
  name.value = me.name;
  const saveName = () => {
    const cleaned = cleanName(name.value);
    if (!cleaned) { needName(); return; }
    me = { ...me, name: cleaned };
    keep(KEYS.me, me);
    name.value = cleaned;
    delete $('me').dataset.need;
    sayStore(shared ? `名字已儲存：${cleaned}。` : `名字已儲存在這個瀏覽器：${cleaned}。`);
    // The name travels with a vote: sending the votes again carries the new one.
    if (shared) { for (const id of Object.keys(mine)) pending.add(id); void save(); }
    for (const item of items) updateCard(item);
    renderTeam();
  };
  $('save-name').addEventListener('click', saveName);
  name.addEventListener('keydown', event => { if (event.key === 'Enter') saveName(); });
  // A list that changed while a comment was being typed waits until the typing ends.
  document.addEventListener('focusout', () => { setTimeout(() => { if (renderLater && !document.activeElement?.classList.contains('comment')) renderList(); }, 0); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
  window.addEventListener('pagehide', () => { if (pending.size) void save(); });
}
function renderBatches() {
  const box = $('batches');
  box.replaceChildren(el('span', 'grouplabel', '批次'));
  for (const batch of catalog?.batches ?? []) {
    const chip = el('button', 'chipbtn', batch.title);
    chip.type = 'button'; chip.dataset.b = batch.id; chip.dataset.label = batch.title;
    chip.title = `${rocDate(batch.id)}${batch.note ? `：${batch.note}` : ''}`;
    chip.setAttribute('aria-pressed', String(view.batch === batch.id));
    chip.addEventListener('click', () => setBatch(view.batch === batch.id ? '' : batch.id));
    box.append(chip);
  }
}
function renderFoot() {
  if (!catalog) return;
  const samples = catalog.samples;
  const time = new Date(catalog.generatedAt).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
  $('foot').replaceChildren(
    el('p', '', samples ? `觸發次數來自 ${samples.files} 批、${samples.rx} 張去識別化處方樣本（可對到健保碼的藥品 ${samples.drugs} 個），只統計次數；新增或改過的規則還沒有次數。頁面不含任何樣本內容。` : '這次的清單沒有附上樣本次數。'),
    el('p', '', `規則表版本 ${catalog.rulesVersion}，清單更新於 ${time}。規則表有新增或修改時，清單會跟著網站一起更新：新條文自動出現在待審，改過內容的規則回到待審。`));
}

async function start() {
  setupBar();
  setMode(view.mode);
  if (!REVIEW_ENDPOINT) sayStore('這個網站還沒有設定團隊共用儲存：你的決定只存在這個瀏覽器，審完請按「複製我的審核結果」交給負責人。', true);
  else if (!code) sayStore('這個連結沒有團隊代碼：你的決定只存在這個瀏覽器。要和團隊一起審核，請用負責人分享的完整連結開啟。', true);
  else sayStore('正在連線團隊共用儲存…');
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${REVIEW_CATALOG}`, { cache: 'no-cache' });
    const data = await response.json() as Catalog;
    if (!response.ok || data.format !== CATALOG_FORMAT || !Array.isArray(data.items)) throw new Error('format');
    catalog = data;
  } catch {
    $('list').replaceChildren(el('p', 'empty', '規則清單讀取失敗，請重新整理頁面。'));
    return;
  }
  // The published proposals are an extra: the page works without them.
  try { published = publishedProposals(await (await fetch(`${import.meta.env.BASE_URL}${REVIEW_PROPOSALS}`, { cache: 'no-cache' })).json()); } catch { published = []; }
  batchOrder = Object.fromEntries(catalog.batches.map((batch, n) => [batch.id, n]));
  applyItems();
  renderBatches();
  renderFoot();
  renderList();
  renderCounts();
  if (view.mode === 'deck') deck.show();
  if (shared) {
    if (!me.name) needName();
    await load(true);
    setInterval(() => { if (!document.hidden) void load(); }, POLL);
  }
}
void start();
