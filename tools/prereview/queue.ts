/**
 * What the AI pre-review may take up, and the rule as the model reads it. Pure functions: no network, no files.
 * Two kinds of item: the weekly proposals (P…) and the rules on the review page (review.json items: I, C, D, K, S…). Questions
 * (待決定, multiple choice) and settings are left out.
 */
import { closed, preReviewer, proposalItem, splitVotes, teamStatus, type Catalog, type Item, type TeamVotes, type Vote } from '../../src/review-model';
import type { Proposal } from '../../src/rx-proposals';

export interface Task { id: string; title: string; item: Item; proposal?: Proposal }
export interface QueueOptions {
  reviewer: string;
  /** Rerun answers without a lean (only 其他意見 or a comment). */
  redo?: boolean;
  /** Skip items any AI pre-reviewer has answered (on a rule: since it last changed). */
  unreviewed?: boolean;
  /** Rerun items this reviewer answered (with only). */
  again?: boolean;
  /** One item by id: then an item the team already agreed on (達門檻) is taken too; a closed one never is. */
  only?: string;
}
export interface TeamView { reviewers: Record<string, string>; votes: TeamVotes; quorum?: number }

const SKIPPED_TABLES = new Set(['questions', 'settings', 'proposals']);
/** A vote that still speaks to the item as it is now. */
const answers = (item: Item, vote: Vote | undefined): vote is Vote => !!vote && (!!vote.d || !!vote.c.trim()) && vote.t >= item.changed;
const order = (task: Task) => task.item.batch.replace(/\D/g, '');

/** Open items not yet agreed on and not yet pre-reviewed by this reviewer (with unreviewed: by any), oldest batch first. */
export function pickQueue(proposals: Proposal[], catalog: Pick<Catalog, 'items' | 'proposals'>, team: TeamView, options: QueueOptions): Task[] {
  const decided = new Map((catalog.proposals ?? []).map(p => [p.id, p]));
  const tasks: Task[] = [
    ...proposals.map(p => ({ id: p.id, title: p.title, item: proposalItem(p, decided.get(p.id)), proposal: p })),
    ...catalog.items.filter(item => !SKIPPED_TABLES.has(item.table)).map(item => ({ id: item.id, title: ruleTitle(item), item })),
  ];
  const isPre = (who: string) => preReviewer(team.reviewers[who]);
  const done = (item: Item) => {
    const vote = team.votes[item.id]?.[options.reviewer];
    if (!answers(item, vote)) return false;
    return options.redo ? vote.d === '同意' || vote.d === '不同意' : true;
  };
  const anyPre = (item: Item) => Object.entries(splitVotes(team.votes[item.id], isPre).pre).some(([, vote]) => answers(item, vote));
  const agreed = (item: Item) => teamStatus(item, splitVotes(team.votes[item.id], isPre).team, team.quorum ?? 2) === '達門檻';
  return tasks.filter(({ id, item }) => (!options.only || id === options.only) && !closed(item) && (!!options.only || !agreed(item))
    && (options.again || !done(item)) && !(options.unreviewed && anyPre(item)))
    .sort((a, b) => order(a).localeCompare(order(b)) || Number(!a.proposal) - Number(!b.proposal) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

export const TABLE_NAMES: Record<string, string> = { indications: '適應症', co: '同處方', cautions: '注意事項', specialty: '科別常用', classes: '藥品分類' };
/** What each table's row does, for the model. */
const TABLE_MEANING: Record<string, string> = {
  indications: '這個藥（ATC）配上列出的任一個 ICD-10 診斷碼，就算有適應症，不提示。',
  co: '這個藥（ATC）在同一張處方有列出的藥時，就算可由同處方的藥解釋，不提示。',
  cautions: '藥品（ATC 或關鍵字）符合、且所有條件都成立時，憑單以該等級顯示這則訊息。',
  specialty: '這個科別開的列出的藥，以「科別常用」解釋。',
  classes: '低風險：這類藥不提示；高警訊：這類藥判為黃色。',
};
const condText = (cond: NonNullable<Item['conds']>[number]) => cond.kind === '診斷' ? (cond.dx ?? []).map(chip => `${chip.t} ${chip.zh}`).join('、') : cond.kind === '同處方' ? cond.atc ?? '' : cond.text ?? '';

/** A rule's one-line title, as the page heads it. */
export function ruleTitle(item: Item): string {
  switch (item.table) {
    case 'indications': return `${item.cls ?? item.atc}：${(item.icd ?? []).map(chip => chip.t).join(' ')}`;
    case 'co': return `${item.atc} 可由同處方 ${item.partners} 解釋`;
    case 'cautions': return item.msg ?? '';
    case 'specialty': return `${item.dept} ${item.name}常開的藥`;
    case 'classes': return `${item.kind}：${item.desc}`;
    default: return item.title ?? item.id;
  }
}

/** ATC codes with their Chinese class names from the catalog (the longest prefix it knows). */
export function atcText(codes: string | undefined, names: Catalog['atc']): string {
  return (codes ?? '').split(/\s+/).filter(Boolean).map(code => {
    for (let n = code.length; n >= 3; n--) { const zh = names[code.slice(0, n)]?.zh; if (zh) return `${code}（${zh}）`; }
    return code;
  }).join(' ');
}

function hitsText(item: Item): string {
  if (item.hits == null) return '沒有次數（新增或改過後還沒用樣本重算）';
  const n = item.hits;
  switch (item.table) {
    case 'indications': case 'co': return n ? `樣本中解釋 ${n} 個藥` : '樣本中未用到';
    case 'cautions': return n ? `樣本中觸發 ${n} 次` : '樣本中未觸發';
    case 'specialty': return n ? `樣本中以科別解釋 ${n} 個藥` : '樣本中未用到';
    case 'classes': return item.kind === '低風險' ? (n ? `不提示 ${n} 個藥` : '樣本中未用到') : (n ? `判為黃色 ${n} 個藥` : '樣本中沒有判為黃色');
    default: return String(n);
  }
}

/** The rule as data for the prompt: every field the page shows, nothing from the votes. */
export function ruleData(item: Item, names: Catalog['atc']): string {
  const lines: [string, string | undefined][] = [
    ['編號', item.id],
    ['類別', `${TABLE_NAMES[item.table] ?? item.table}（${item.table}）：${TABLE_MEANING[item.table] ?? ''}`],
    ['批次', item.batch],
    ['科別', item.dept ? `${item.dept} ${item.name ?? ''}` : undefined],
    ['類型', item.table === 'classes' ? `${item.kind}：${item.desc}` : undefined],
    ['藥品 ATC', atcText(item.atc, names) || undefined],
    ['藥品類別', item.cls],
    ['關鍵字', item.keyword || undefined],
    ['ICD-10', item.icd?.length ? item.icd.map(chip => `${chip.t} ${chip.zh}`).join('、') : undefined],
    ['同處方的藥', item.partners ? atcText(item.partners, names) : undefined],
    ['條件', item.conds?.length ? item.conds.map(cond => `${cond.kind} ${cond.kind === '同處方' ? atcText(cond.atc, names) : condText(cond)}`).join('＋') : undefined],
    ['等級', item.level],
    ['訊息', item.msg],
    ['依據等級', item.basis],
    ['備註', item.note],
    ['命中', hitsText(item)],
    ['說明', item.why],
    ['出處', item.ref],
    ['出處連結', item.links?.length ? item.links.map(link => `${link.t} ${link.u}`).join('；') : undefined],
    ['證據', item.evidence],
    ['改寫前', item.prev],
    ['頁面註記', item.flags.length ? item.flags.join('；') : undefined],
  ];
  return lines.filter(([, value]) => value).map(([label, value]) => `${label}：${value}`).join('\n');
}
