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
/** One reviewer's word on one item: the decision ('' while only a comment), the comment, and when it was made. */
export interface Vote { d: Choice | ''; c: string; t: string }
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

export interface Tally { 同意: string[]; 不同意: string[]; 其他意見: string[]; comments: { who: string; d: Choice | ''; c: string }[] }
/** The votes that still count on an item, by decision, as reviewer ids; comments with them. */
export function tally(item: Item, votes: Record<string, Vote> | undefined): Tally {
  const result: Tally = { 同意: [], 不同意: [], 其他意見: [], comments: [] };
  for (const [who, vote] of Object.entries(votes ?? {})) {
    if (stale(item, vote)) continue;
    if (vote.d) result[vote.d].push(who);
    if (vote.c.trim()) result.comments.push({ who, d: vote.d, c: vote.c.trim() });
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

/** What the team's sheet answers to a read. */
export interface TeamState { quorum: number; reviewers: Record<string, string>; votes: TeamVotes; proposals: Proposal[]; skipped: number }
const isVote = (value: unknown): value is Vote => !!value && typeof value === 'object'
  && ['', ...CHOICES].includes((value as Vote).d) && typeof (value as Vote).c === 'string' && typeof (value as Vote).t === 'string';
/** The answer as the page uses it, or why it cannot: everything from the network is checked before it is shown. */
export function teamState(answer: unknown): TeamState | { error: string } {
  const data = answer as { ok?: unknown; error?: unknown; quorum?: unknown; reviewers?: unknown; votes?: unknown; proposals?: unknown };
  if (!data || typeof data !== 'object') return { error: '回應格式不對' };
  if (data.ok !== true) return { error: data.error === 'code' ? '團隊代碼不對' : '儲存空間回應錯誤' };
  const reviewers: Record<string, string> = {};
  for (const [id, name] of Object.entries(data.reviewers ?? {})) if (typeof name === 'string') reviewers[id] = name.slice(0, 30);
  const votes: TeamVotes = {};
  for (const [item, byReviewer] of Object.entries(data.votes ?? {})) {
    if (!byReviewer || typeof byReviewer !== 'object') continue;
    for (const [who, vote] of Object.entries(byReviewer)) if (isVote(vote)) (votes[item] ??= {})[who] = { d: vote.d, c: vote.c.slice(0, 1000), t: vote.t };
  }
  const proposals: Proposal[] = [];
  let skipped = 0;
  for (const sheet of Array.isArray(data.proposals) ? data.proposals : []) {
    const read = proposalsOfRows((sheet as { rows?: unknown })?.rows);
    proposals.push(...read.proposals); skipped += read.skipped;
  }
  const unique = [...new Map(proposals.map(proposal => [proposal.id, proposal])).values()];
  return { quorum: Number.isInteger(data.quorum) && (data.quorum as number) > 0 ? data.quorum as number : 2, reviewers, votes, proposals: unique, skipped };
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
/** The request that saves votes; at most 200 at a time. */
export function voteRequest(code: string, reviewer: Reviewer, votes: Votes) {
  return { format: REVIEW_FORMAT, version: 1 as const, code, reviewer: { id: reviewer.id, name: cleanName(reviewer.name) },
    votes: Object.entries(votes).slice(0, 200).map(([id, vote]) => ({ id, d: vote.d, c: vote.c.slice(0, 1000), t: vote.t })) };
}
