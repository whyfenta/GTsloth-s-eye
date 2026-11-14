/**
 * The review page's card mode (src/review-deck.ts): which card comes next, how much of today's stack is done, and what this
 * reviewer has moved forward. Everything is worked out from the votes the page already has (their times `t`); nothing new is
 * sent to the team's sheet. Pure functions: no DOM, no network, no storage.
 */
import { stale, tally, type Catalog, type Item, type Vote, type Votes } from './review-model';

/** How many cards a day's stack holds: the reviewer picks one of these; 5 until then. */
export const GOALS = [3, 5, 10] as const;
export const DEFAULT_GOAL = 5;
export const goalOf = (value: unknown): number => GOALS.includes(value as typeof GOALS[number]) ? value as number : DEFAULT_GOAL;

/** The local calendar day of a time as YYYY-MM-DD ('' when it is not a time). */
export function dayKey(time: Date | string): string {
  const date = typeof time === 'string' ? new Date(time) : time;
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** Monday 00:00, local time, of the week `now` is in. */
export function weekStart(now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  return start;
}

/** The items this reviewer decided on that day; a comment alone is not a decision. */
export const decidedOn = (mine: Votes, day: string): string[] => Object.entries(mine).filter(([, vote]) => vote.d && dayKey(vote.t) === day).map(([id]) => id);
/**
 * This week, Monday first: true on the days this reviewer decided something. A vote keeps only its latest time, so the days
 * this browser saw a decision (`log`, YYYY-MM-DD) are counted too.
 */
export function weekDays(mine: Votes, log: string[], now: Date): boolean[] {
  const start = weekStart(now);
  const seen = new Set([...log, ...Object.values(mine).filter(vote => vote.d).map(vote => dayKey(vote.t))]);
  return Array.from({ length: 7 }, (_, n) => seen.has(dayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + n))));
}

/** Nobody has looked at this item yet: no pharmacist and no AI pre-review has a decision, a comment or a link on it. */
export const fresh = (votes: Record<string, Vote> | undefined) => Object.values(votes ?? {}).every(vote => !vote.d && !vote.c.trim() && !vote.l?.length);
/**
 * One more agreement reaches the quorum: the other pharmacists' counted votes (this reviewer's left out) are all agreements,
 * one short of the quorum, and at least one.
 */
export function oneVoteAway(item: Item, others: Record<string, Vote> | undefined, quorum: number): boolean {
  const counted = tally(item, others);
  return !counted.不同意.length && !counted.其他意見.length && counted.同意.length >= 1 && counted.同意.length === Math.max(1, quorum) - 1;
}
/** This reviewer's agreement is the one that reached the quorum: in time order it is the quorum-th, and nobody objects. */
export function reachedBy(item: Item, votes: Record<string, Vote> | undefined, quorum: number, who: string): boolean {
  const counted = tally(item, votes);
  if (counted.不同意.length || counted.其他意見.length) return false;
  const q = Math.max(1, quorum);
  const agreed = counted.同意.map(id => [id, votes![id].t] as const).sort((a, b) => a[1].localeCompare(b[1]));
  return agreed.length >= q && agreed[q - 1][0] === who;
}
/** This reviewer decided before anyone else said anything on the item (pre-reviews included). */
export function firstOn(votes: Record<string, Vote> | undefined, who: string): boolean {
  const own = votes?.[who];
  if (!own?.d) return false;
  return Object.entries(votes ?? {}).every(([id, vote]) => id === who || (!vote.d && !vote.c.trim() && !vote.l?.length) || vote.t > own.t);
}
/** How many items the pharmacists decided on this week (each item once). */
export const teamWeek = (votes: Record<string, Vote>[], since: Date) => votes.filter(byReviewer => Object.values(byReviewer).some(vote => vote.d && new Date(vote.t) >= since)).length;

/**
 * Who reviewed this week and how much: for each pharmacist (AI pre-reviews left out), the items they decided on since Monday.
 * One person on two devices has two reviewer ids under one name, so names are counted, each item once per name. Only those
 * with something this week, by name: the team sees each other, not a ranking.
 */
export function weekBy(votes: Record<string, Vote>[], nameOf: (who: string) => string, counted: (who: string) => boolean, since: Date): { name: string; n: number }[] {
  const by = new Map<string, number>();
  for (const byReviewer of votes) {
    const names = new Set(Object.entries(byReviewer).filter(([who, vote]) => counted(who) && vote.d && new Date(vote.t) >= since).map(([who]) => nameOf(who).trim()).filter(Boolean));
    for (const name of names) by.set(name, (by.get(name) ?? 0) + 1);
  }
  return [...by].map(([name, n]) => ({ name, n })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

/** The ATC codes a card is about: its drugs, the drugs it can be prescribed with, and those in its conditions. */
export function atcCodes(item: Item): string[] {
  const specs = [item.atc, item.partners, ...(item.conds ?? []).map(cond => cond.atc)];
  return specs.flatMap(spec => String(spec ?? '').split(/\s+/)).map(token => token.split('@')[0]).filter(code => /^[A-Z]\d\d/.test(code));
}
/** The drug classes the cards were about, by their Chinese names, each once, in the order met. */
export function learnedClasses(items: Item[], atc: Catalog['atc'], max = 8): string[] {
  const names: string[] = [];
  for (const item of items) for (const code of atcCodes(item)) {
    const name = atc[code]?.zh;
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, max);
}

/** What the next-card choice needs to know about an item still waiting for this reviewer. */
export interface Candidate { id: string; oneAway: boolean; pre: boolean; again: boolean; fresh: boolean }
export const candidate = (item: Item, own: Vote | undefined, others: Record<string, Vote>, all: Record<string, Vote>, pre: boolean, quorum: number): Candidate =>
  ({ id: item.id, oneAway: oneVoteAway(item, others, quorum), pre, again: stale(item, own), fresh: fresh(all) });
/** The last card of each stack is the challenge: a card nobody has looked at yet. */
export const bossSlot = (decidedToday: number, goal: number) => (decidedToday + 1) % Math.max(1, goal) === 0;
/**
 * The next card, from the candidates in list order. A challenge slot takes the first card nobody has looked at. Otherwise:
 * one vote from the quorum, then those with an AI pre-review, then those this reviewer decided before they changed, then list
 * order; the challenge card is kept back for its slot while there is anything else.
 */
export function nextCard(candidates: Candidate[], boss: boolean): { id: string; boss: boolean } | undefined {
  if (!candidates.length) return undefined;
  const challenge = candidates.find(item => item.fresh);
  if (boss && challenge) return { id: challenge.id, boss: true };
  const pool = candidates.length > 1 ? candidates.filter(item => item !== challenge) : candidates;
  const rank = (item: Candidate) => item.oneAway ? 0 : item.pre ? 1 : item.again ? 2 : 3;
  const best = pool.reduce((a, b) => rank(b) < rank(a) ? b : a);
  return { id: best.id, boss: false };
}
