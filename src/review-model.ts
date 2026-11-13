/**
 * The pharmacists' review page (review/): what a reviewer still has to look at, what the team has agreed on, and what the
 * requests to the team's sheet (docs/rx-review-apps-script.gs) look like. Pure functions: no DOM, no network, no storage.
 */
import { proposalsOfRows, type Proposal } from './rx-proposals';

export const REVIEW_FORMAT = 'gtsloth-rx-review';
export const CATALOG_FORMAT = 'gtsloth-rx-review';
export const CHOICES = ['同意', '不同意', '其他意見'] as const;
export type Choice = typeof CHOICES[number];
/** A proposal is voted on with the same three values, worded for what they mean there. */
export const PROPOSAL_LABEL: Record<Choice, string> = { 同意: '採用', 不同意: '不採用', 其他意見: '需更多樣本或修改' };
/** A link a reviewer gives as evidence: what it is ('' when not said) and an https address. */
export interface Link { t: string; u: string }
/**
 * One reviewer's word on one item: the decision ('' while only a comment), the comment, when it was made, and the evidence
 * links (left out when there are none), so the comment can stay the conclusion and the addresses sit apart from it.
 */
export interface Vote { d: Choice | ''; c: string; t: string; l?: Link[] }
export type Votes = Record<string, Vote>;
/** Everyone's votes: item id → reviewer id → vote. */
export type TeamVotes = Record<string, Record<string, Vote>>;
export interface Chip { t: string; zh: string }
export interface Condition { kind: string; dx?: Chip[]; atc?: string; text?: string }
/** A rule, setting, question or proposal as the page shows it. `changed`: when its content last changed. */
export interface Item {
  id: string; table: string; batch: string; changed: string; basis: string; flags: string[]; hits: number | null;
  why?: string; ref?: string; links?: { t: string; u: string }[]; outcome?: string; prev?: string; approved?: { at: string; n: number };
  atc?: string; cls?: string; icd?: Chip[]; note?: string; partners?: string; keyword?: string; conds?: Condition[]; level?: string; msg?: string;
  dept?: string; name?: string; kind?: string; desc?: string; value?: string; options?: string; title?: string;
  file?: string; row?: string; evidence?: string; trial?: string;
}
export interface Catalog {
  format: string; generatedAt: string; rulesVersion: string; batches: { id: string; title: string; note?: string }[];
  samples: { rx: number; drugs: number; files: number } | null; items: Item[];
  retired: { id: string; text: string; outcome?: string }[]; atc: Record<string, { zh: string; ex: string[]; n: number; seen?: number }>;
  proposals?: { id: string; title: string; status: string; decided: string; note?: string; rules?: string[] }[];
}

/** The review of this item is over: an opinion was carried out, or the team agreed and it was closed as it stands. */
export const closed = (item: Item) => !!item.outcome || !!item.approved;
/** A decision made before the item last changed no longer counts. */
export const stale = (item: Item, vote: Vote | undefined) => !!(vote?.d && vote.t < item.changed);
/** This reviewer has nothing left to do here. */
export const done = (item: Item, vote: Vote | undefined) => closed(item) || !!(vote?.d && vote.t >= item.changed);

/**
 * An AI pre-review: a reviewer whose name contains 預審 (e.g. the scheduled Codex run, 「Codex-Sol預審」). Its votes are shown
 * apart and never count toward the quorum or a split: only the pharmacists' votes decide where the team stands.
 */
export const preReviewer = (name: string | undefined) => !!name && name.includes('預審');
/** An item's votes split into the team's and the pre-reviews'. */
export function splitVotes(votes: Record<string, Vote> | undefined, isPre: (who: string) => boolean) {
  const team: Record<string, Vote> = {}, pre: Record<string, Vote> = {};
  for (const [who, vote] of Object.entries(votes ?? {})) (isPre(who) ? pre : team)[who] = vote;
  return { team, pre };
}

export interface Tally { 同意: string[]; 不同意: string[]; 其他意見: string[]; comments: { who: string; d: Choice | ''; c: string; l?: Link[] }[] }
/** The votes that still count on an item, by decision, as reviewer ids; comments and evidence links with them. */
export function tally(item: Item, votes: Record<string, Vote> | undefined): Tally {
  const result: Tally = { 同意: [], 不同意: [], 其他意見: [], comments: [] };
  for (const [who, vote] of Object.entries(votes ?? {})) {
    if (stale(item, vote)) continue;
    if (vote.d) result[vote.d].push(who);
    if (vote.c.trim() || vote.l?.length) result.comments.push({ who, d: vote.d, c: vote.c.trim(), ...withLinks(vote.l) });
  }
  return result;
}
export type TeamStatus = '已結案' | '達門檻' | '有分歧' | '審核中' | '未審';
/**
 * Where the team stands: agreed (enough reviewers agree and nobody objects or has another opinion), split (someone objects or
 * has an opinion: the owner decides), under way, or untouched. Reaching the quorum changes nothing by itself: the rule tables
 * and the ledger are updated by hand, from this.
 */
export function teamStatus(item: Item, votes: Record<string, Vote> | undefined, quorum: number): TeamStatus {
  if (closed(item)) return '已結案';
  const t = tally(item, votes);
  if (t.不同意.length || t.其他意見.length) return '有分歧';
  if (t.同意.length >= Math.max(1, quorum)) return '達門檻';
  return t.同意.length ? '審核中' : '未審';
}

/** A proposal from the weekly review as an item; its content never changes, so every vote on it counts. */
export function proposalItem(proposal: Proposal, done?: { status: string; decided: string; note?: string }): Item {
  return { id: proposal.id, table: 'proposals', batch: proposal.id.slice(1, 9), changed: '', basis: proposal.basis, flags: [], hits: null,
    title: proposal.title, kind: proposal.kind, file: proposal.file, row: proposal.row, evidence: proposal.evidence, trial: proposal.trial, note: proposal.note,
    ...(done ? { outcome: `${done.status}（${done.decided}）${done.note ? `：${done.note}` : ''}` } : {}) };
}

export const MAX_LINKS = 10;
export const MAX_LINK_LABEL = 40;
export const MAX_URL = 500;
/** An address the page will link to: https only, no spaces or control characters, a host, at most 500 characters. */
export const linkUrl = (u: unknown): u is string => typeof u === 'string' && u.length <= MAX_URL && /^https:\/\/[^\s/?#\\@]+(?:[/?#][^\s]*)?$/.test(u)
  && !/[\u0000-\u001F\u007F]/.test(u);
const cleanLabel = (text: string) => cleanName(text).replace(/[\s:：\-–—]+$/, '').slice(0, MAX_LINK_LABEL).trim();
/** The links as kept on a vote: only when there are some. */
export const withLinks = (links: Link[] | undefined) => links?.length ? { l: links } : {};
/**
 * The evidence box as links: one a line, an optional short label then the address (「仿單 https://…」). Lines that are not
 * like that, and links past the tenth, are counted in `bad` and not kept; the same address twice is kept once.
 */
export function parseLinks(text: string): { links: Link[]; bad: number } {
  const links: Link[] = [];
  let bad = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(.*?)\s*(https:\/\/\S+)$/.exec(line);
    const label = match ? cleanLabel(match[1]) : '';
    if (!match || !linkUrl(match[2]) || /https?:\/\//.test(match[1]) || links.length >= MAX_LINKS) { bad++; continue; }
    if (!links.some(link => link.u === match[2])) links.push({ t: label, u: match[2] });
  }
  return { links, bad };
}
/** The links back as the evidence box shows them. */
export const linksText = (links: Link[] | undefined) => (links ?? []).map(link => link.t ? `${link.t} ${link.u}` : link.u).join('\n');
/** Links from the network, checked: what is not a proper link is dropped. */
export function cleanLinks(value: unknown): Link[] {
  if (!Array.isArray(value)) return [];
  const links: Link[] = [];
  for (const link of value.slice(0, MAX_LINKS)) {
    const { t, u } = (link ?? {}) as Partial<Link>;
    if (linkUrl(u) && !links.some(other => other.u === u)) links.push({ t: typeof t === 'string' ? cleanLabel(t) : '', u });
  }
  return links;
}
/** What a link reads as on the page: its label, or the site and a hint of the path. */
export function linkLabel(link: Link): string {
  if (link.t) return link.t;
  try { const url = new URL(link.u); return url.host.replace(/^www\./, '') + (url.pathname.length > 1 || url.search ? '/…' : ''); } catch { return link.u.slice(0, 40); }
}

/** What the team's sheet answers to a read. */
export interface TeamState {
  quorum: number; reviewers: Record<string, string>; votes: TeamVotes; proposals: Proposal[]; skipped: number;
  /** Why the sheet could not read the proposal sheets ('' when it could): the owner fixes it in the script editor. */
  proposalProblem: string;
  /** The sheet's script keeps evidence links: one deployed before them drops them, so the page does not offer the box. */
  linksSaved: boolean;
}
const isVote = (value: unknown): value is Vote => !!value && typeof value === 'object'
  && ['', ...CHOICES].includes((value as Vote).d) && typeof (value as Vote).c === 'string' && typeof (value as Vote).t === 'string';
/** The answer as the page uses it, or why it cannot: everything from the network is checked before it is shown. */
export function teamState(answer: unknown): TeamState | { error: string } {
  const data = answer as { ok?: unknown; error?: unknown; quorum?: unknown; reviewers?: unknown; votes?: unknown; proposals?: unknown; proposalProblem?: unknown; links?: unknown };
  if (!data || typeof data !== 'object') return { error: '回應格式不對' };
  if (data.ok !== true) return { error: data.error === 'code' ? '團隊代碼不對' : '儲存空間回應錯誤' };
  const reviewers: Record<string, string> = {};
  for (const [id, name] of Object.entries(data.reviewers ?? {})) if (typeof name === 'string') reviewers[id] = name.slice(0, 30);
  const votes: TeamVotes = {};
  for (const [item, byReviewer] of Object.entries(data.votes ?? {})) {
    if (!byReviewer || typeof byReviewer !== 'object') continue;
    for (const [who, vote] of Object.entries(byReviewer)) if (isVote(vote)) (votes[item] ??= {})[who] = { d: vote.d, c: vote.c.slice(0, 1000), t: vote.t, ...withLinks(cleanLinks(vote.l)) };
  }
  const proposals: Proposal[] = [];
  let skipped = 0;
  for (const sheet of Array.isArray(data.proposals) ? data.proposals : []) {
    const read = proposalsOfRows((sheet as { rows?: unknown })?.rows);
    proposals.push(...read.proposals); skipped += read.skipped;
  }
  const unique = [...new Map(proposals.map(proposal => [proposal.id, proposal])).values()];
  return { quorum: Number.isInteger(data.quorum) && (data.quorum as number) > 0 ? data.quorum as number : 2, reviewers, votes, proposals: unique, skipped,
    proposalProblem: typeof data.proposalProblem === 'string' ? data.proposalProblem.slice(0, 200) : '', linksSaved: data.links === true };
}

/** This reviewer's votes with what the sheet holds: for each item the later one stands, so two devices do not undo each other. */
export function mergeVotes(local: Votes, remote: Votes): Votes {
  const merged: Votes = { ...remote };
  for (const [id, vote] of Object.entries(local)) if (!merged[id] || vote.t >= merged[id].t) merged[id] = vote;
  return merged;
}
export interface Reviewer { id: string; name: string }
/** A reviewer's name as the team sees it: trimmed, one line, at most 30 characters. */
export const cleanName = (name: string) => name.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
/** A new reviewer id: 16 letters and digits, random, kept in the browser. It says nothing about the person. */
export function reviewerId(random: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...random(new Uint8Array(16))].map(byte => letters[byte % letters.length]).join('');
}
/**
 * The request that saves votes; at most 200 at a time. A vote's `l` is its evidence links ([{ t: '仿單', u: 'https://…' }], at
 * most 10): left out, the vote has none. An AI pre-review sends its addresses here and keeps `c` to its conclusion.
 */
export function voteRequest(code: string, reviewer: Reviewer, votes: Votes) {
  return { format: REVIEW_FORMAT, version: 1 as const, code, reviewer: { id: reviewer.id, name: cleanName(reviewer.name) },
    votes: Object.entries(votes).slice(0, 200).map(([id, vote]) => ({ id, d: vote.d, c: vote.c.slice(0, 1000), t: vote.t, ...withLinks(cleanLinks(vote.l)) })) };
}
