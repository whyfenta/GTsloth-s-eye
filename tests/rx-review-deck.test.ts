import assert from 'node:assert/strict';
import type { Item, Vote } from '../src/review-model';
import { atcCodes, bossSlot, candidate, dayKey, decidedOn, firstOn, fresh, goalOf, learnedClasses, nextCard, oneVoteAway, reachedBy, teamWeek, weekBy, weekDays, weekStart, type Candidate } from '../src/review-progress';

// The review page's card mode: today's stack, this week, what this reviewer moved forward, and which card comes next.
// Times are built in local time, as the page counts days in the reviewer's own time zone.
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).toISOString(); // November 2026: the 16th is a Monday
const item = (changes: Partial<Item> = {}): Item => ({ id: 'C56', table: 'cautions', batch: '2026-11-10', changed: at(10, 0), basis: 'Beers 2023', flags: [], hits: null, ...changes });
const vote = (d: Vote['d'], t = at(14), c = ''): Vote => ({ d, c, t });

// The goal is one of 3, 5 or 10; anything else is 5.
assert.equal(goalOf(3), 3); assert.equal(goalOf(10), 10); assert.equal(goalOf(7), 5); assert.equal(goalOf(undefined), 5); assert.equal(goalOf('5'), 5);

// Days are local calendar days; the week starts on Monday.
assert.equal(dayKey(new Date(2026, 10, 14, 23, 59)), '2026-11-14');
assert.equal(dayKey('not a time'), '');
assert.equal(dayKey(weekStart(new Date(2026, 10, 22, 20))), '2026-11-16', 'Sunday belongs to the week that began on Monday');
assert.equal(dayKey(weekStart(new Date(2026, 10, 16, 0, 5))), '2026-11-16');

// Today's count: decisions made today; a comment alone is not one, nor is yesterday's.
const mine = { a: vote('同意', at(14, 9)), b: vote('不同意', at(14, 18)), c: vote('', at(14), '只寫意見'), d: vote('同意', at(13, 23)) };
assert.deepEqual(decidedOn(mine, '2026-11-14'), ['a', 'b']);
assert.deepEqual(decidedOn(mine, '2026-11-13'), ['d']);

// This week, Monday first: the days with a decision, and the days this browser logged (a later vote replaces an earlier time).
assert.deepEqual(weekDays({ a: vote('同意', at(17)), b: vote('', at(18), '意見') }, ['2026-11-16', '2026-11-09'], new Date(2026, 10, 19)),
  [true, true, false, false, false, false, false]);

// Nobody has looked at an item: no decisions, comments or links from anyone (an emptied vote counts as nothing).
assert.equal(fresh(undefined), true);
assert.equal(fresh({ x: vote('', at(14)) }), true);
assert.equal(fresh({ x: vote('', at(14), '預審意見') }), false);
assert.equal(fresh({ x: { ...vote(''), l: [{ t: '仿單', u: 'https://example.org' }] } }), false);
assert.equal(fresh({ x: vote('同意') }), false);

// One vote away: the others' counted agreements are one short of the quorum, nobody objects, and at least one agreed.
assert.equal(oneVoteAway(item(), { p: vote('同意') }, 2), true);
assert.equal(oneVoteAway(item(), {}, 2), false);
assert.equal(oneVoteAway(item(), {}, 1), false, 'with a quorum of one, every untouched card would be one vote away');
assert.equal(oneVoteAway(item(), { p: vote('同意'), q: vote('其他意見') }, 2), false);
assert.equal(oneVoteAway(item(), { p: vote('同意', at(9)) }, 2), false, 'a vote from before the change does not count');
assert.equal(oneVoteAway(item(), { p: vote('同意'), q: vote('同意') }, 3), true);

// Reached by: this reviewer's agreement is the quorum-th in time order, and nobody objects.
assert.equal(reachedBy(item(), { p: vote('同意', at(12)), me: vote('同意', at(14)) }, 2, 'me'), true);
assert.equal(reachedBy(item(), { me: vote('同意', at(12)), p: vote('同意', at(14)) }, 2, 'me'), false, 'the other one reached it');
assert.equal(reachedBy(item(), { p: vote('同意', at(12)), q: vote('同意', at(13)), me: vote('同意', at(14)) }, 2, 'me'), false, 'already there before');
assert.equal(reachedBy(item(), { p: vote('同意', at(12)), me: vote('同意', at(14)), q: vote('不同意', at(15)) }, 2, 'me'), false);
assert.equal(reachedBy(item(), { me: vote('同意') }, 2, 'me'), false);
assert.equal(reachedBy(item({ approved: { at: '2026-11-15', n: 2 } }), { p: vote('同意', at(12)), me: vote('同意', at(14)) }, 2, 'me'), true, 'closed since, still this reviewer\'s doing');

// First: this reviewer decided before anyone said anything; an AI pre-review's comment earlier means someone was first.
assert.equal(firstOn({ me: vote('同意', at(12)) }, 'me'), true);
assert.equal(firstOn({ me: vote('同意', at(12)), p: vote('同意', at(14)) }, 'me'), true);
assert.equal(firstOn({ me: vote('同意', at(12)), pre: vote('', at(11), 'AI 預審意見') }, 'me'), false);
assert.equal(firstOn({ me: vote('', at(12), '意見') }, 'me'), false, 'a comment is not a decision');
assert.equal(firstOn({}, 'me'), false);

// The team's week: items with a pharmacist's decision since Monday, each item once.
assert.equal(teamWeek([{ a: vote('同意', at(16)), b: vote('同意', at(17)) }, { a: vote('同意', at(15)) }, { a: vote('', at(17), '意見') }], weekStart(new Date(2026, 10, 18))), 1);

// What the cards were about: their ATC codes (frequency marks dropped), and the drug classes by name, each once.
const statin = item({ id: 'I1', table: 'indications', atc: 'C10AA C10AA', icd: [] });
const caution = item({ id: 'C2', atc: 'C08@HS', conds: [{ kind: '同處方', atc: 'C10AA N05' }, { kind: '年齡', text: '>=65' }] });
assert.deepEqual(atcCodes(caution), ['C08', 'C10AA', 'N05']);
assert.deepEqual(atcCodes(item({ table: 'settings', name: '同成分重複' })), []);
const atc = { C10AA: { zh: 'HMG-CoA 還原酶抑制劑', ex: [], n: 1 }, C08: { zh: '鈣離子阻斷劑', ex: [], n: 1 }, N05: { zh: '', ex: [], n: 0 } };
assert.deepEqual(learnedClasses([statin, caution], atc), ['HMG-CoA 還原酶抑制劑', '鈣離子阻斷劑']);
assert.deepEqual(learnedClasses([statin, caution], atc, 1), ['HMG-CoA 還原酶抑制劑']);

// The challenge is the last card of each stack: the 5th, 10th… of the day with a goal of 5.
assert.equal(bossSlot(0, 5), false); assert.equal(bossSlot(4, 5), true); assert.equal(bossSlot(9, 5), true); assert.equal(bossSlot(2, 3), true);

// The next card: one vote away, then AI pre-reviewed, then decided before it changed, then list order.
const c = (id: string, facts: Partial<Candidate> = {}): Candidate => ({ id, oneAway: false, pre: false, again: false, fresh: false, ...facts });
assert.equal(nextCard([], false), undefined);
assert.deepEqual(nextCard([c('a'), c('b', { again: true }), c('c', { pre: true }), c('d', { oneAway: true })], false), { id: 'd', boss: false });
assert.deepEqual(nextCard([c('a'), c('b', { again: true }), c('c', { pre: true })], false), { id: 'c', boss: false });
assert.deepEqual(nextCard([c('a'), c('b', { again: true })], false), { id: 'b', boss: false });
assert.deepEqual(nextCard([c('a'), c('b')], false), { id: 'a', boss: false }, 'list order within a rank');
// The first card nobody has looked at waits for the challenge slot while there is anything else; later fresh cards are ordinary.
assert.deepEqual(nextCard([c('f', { fresh: true }), c('a')], false), { id: 'a', boss: false });
assert.deepEqual(nextCard([c('f', { fresh: true }), c('g', { fresh: true })], false), { id: 'g', boss: false });
assert.deepEqual(nextCard([c('f', { fresh: true })], false), { id: 'f', boss: false }, 'the only card left is shown');
assert.deepEqual(nextCard([c('a', { oneAway: true }), c('f', { fresh: true }), c('g', { fresh: true })], true), { id: 'f', boss: true });
assert.deepEqual(nextCard([c('a', { oneAway: true }), c('b', { pre: true })], true), { id: 'a', boss: false }, 'no fresh card: an ordinary one, not shown as a challenge');

// A candidate's facts from the votes: an AI pre-review makes a card not fresh, and the reviewer's own stale decision is "again".
const rule = item();
assert.deepEqual(candidate(rule, vote('同意', at(9)), { p: vote('同意') }, { p: vote('同意'), me: vote('同意', at(9)) }, false, 2),
  { id: 'C56', oneAway: true, pre: false, again: true, fresh: false });
assert.deepEqual(candidate(rule, undefined, {}, { pre: vote('同意') }, true, 2), { id: 'C56', oneAway: false, pre: true, again: false, fresh: false });
assert.deepEqual(candidate(rule, undefined, {}, {}, false, 2), { id: 'C56', oneAway: false, pre: false, again: false, fresh: true });

// Who reviewed this week: by name (two devices of one person count once per item), pharmacists only, decisions since Monday.
const names: Record<string, string> = { a1: '王藥師', a2: '王藥師', b: '林藥師', pre: 'Codex-Sol預審', z: '' };
const since = weekStart(new Date(2026, 10, 18));
assert.deepEqual(weekBy([
  { a1: vote('同意', at(16)), a2: vote('同意', at(17)), b: vote('不同意', at(17)), pre: vote('同意', at(17)) },
  { a2: vote('同意', at(18)), b: vote('', at(18), '只寫意見'), z: vote('同意', at(18)) },
  { b: vote('同意', at(14)) },
], who => names[who] ?? '', who => !who.startsWith('pre'), since), [{ name: '林藥師', n: 1 }, { name: '王藥師', n: 2 }].sort((x, y) => x.name.localeCompare(y.name, 'zh-Hant')));
assert.deepEqual(weekBy([], () => '', () => true, since), []);

console.log('rx-review-deck: ok');
