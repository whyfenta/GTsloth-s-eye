// Offline tests of the citation-fix rules (checks.ts): what a model may and may not change when sent back to fix citations.
import assert from 'node:assert/strict';
import { asSources, checkFix, citationKey, sameWording, titlesMatch, type Check, type Verdict } from '../tools/prereview/checks';

const STOPP = 'STOPP/START criteria for potentially inappropriate prescribing in older people: version 3';
const PIM = 'The updated PIM-Taiwan criteria: a list of potentially inappropriate medications in older people';
const before: Verdict = {
  decision: '同意', confidence: '中',
  comment: '依據應改。STOPP v3（PMID:37256475）已刪除 C2；PIM-Taiwan 2018（PMID:31662854）僅限高劑量 aspirin。',
  citations: [{ id: 'PMID:37256475', title: STOPP }, { id: 'PMID:31662854', title: PIM }], sources: [],
  implementation: { complexity: '只改規則表', note: '只改依據欄。' },
};
const results: Check[] = [
  { id: 'PMID37256475', claimed: STOPP, actual: `${STOPP}.`, ok: true },
  { id: 'PMID31662854', claimed: PIM, actual: 'Thanks to Partners, Sponsors and Exhibitors.', ok: false },
];
const fixed = (changes: Partial<Verdict>): Verdict => ({ ...before, ...changes });

// Allowed: the wrong number replaced by the right one for the same paper.
const replaced = fixed({ comment: before.comment.replace('31662854', '31632624'), citations: [before.citations[0], { id: 'PMID:31632624', title: PIM }] });
assert.ok(checkFix(before, replaced, results) > 0.99);
// Allowed: the citation dropped, with its mention.
const dropped = fixed({ comment: before.comment.replace('（PMID:31662854）', ''), citations: [before.citations[0]] });
assert.ok(checkFix(before, dropped, results) >= 0.9);

// Refused: the title changed to the unrelated paper NCBI holds for the wrong number (the number stays wrong).
assert.throws(() => checkFix(before, fixed({ citations: [before.citations[0], { id: 'PMID:31662854', title: 'Thanks to Partners, Sponsors and Exhibitors' }] }), results), /錯的 PMID31662854 還在/);
// Refused: a new number for a different paper.
assert.throws(() => checkFix(before, fixed({ comment: before.comment.replace('31662854', '12345678'), citations: [before.citations[0], { id: 'PMID:12345678', title: 'Some other trial of aspirin' }] }), results), /不是原本引用的論文/);
// Refused: the decision or confidence moved.
assert.throws(() => checkFix(before, { ...replaced, decision: '不同意' }, results), /改了決定或信心/);
assert.throws(() => checkFix(before, { ...replaced, confidence: '高' }, results), /改了決定或信心/);
// Refused: the implementation assessment moved.
assert.throws(() => checkFix(before, { ...replaced, implementation: { complexity: '要改判斷程式', note: '只改依據欄。' } }, results), /改了實作評估/);
// Refused: the reasoning rewritten.
assert.throws(() => checkFix(before, { ...replaced, comment: '完全不同的理由：這條規則沒有必要，應該刪除，因為門診都會開胃藥。' }, results), /改動過多/);
// Refused: a citation that was right taken out or swapped.
assert.throws(() => checkFix(before, fixed({ citations: [{ id: 'PMID:31632624', title: PIM }] }), results), /原本正確的 PMID37256475 被改動/);

// A number linked but not listed: listing it with NCBI's title is allowed, with another title it is not.
const BEERS = 'American Geriatrics Society 2023 updated AGS Beers Criteria® for potentially inappropriate medication use in older adults';
const unlisted: Check[] = [...results.slice(0, 1), { id: 'PMC12478568', claimed: '', actual: `${BEERS}.`, ok: false, missing: true }];
const onlyStopp: Verdict = { ...before, citations: [before.citations[0]] };
assert.ok(checkFix(onlyStopp, { ...onlyStopp, citations: [...onlyStopp.citations, { id: 'PMC12478568', title: BEERS }] }, unlisted) > 0.99);
assert.throws(() => checkFix(onlyStopp, { ...onlyStopp, citations: [...onlyStopp.citations, { id: 'PMC12478568', title: 'Some other guideline' }] }, unlisted), /補列的 PMC12478568 標題不是/);

// The pieces underneath.
assert.deepEqual(asSources(['https://a.example/x', { t: '仿單', u: 'https://b.example/y' }]), [{ t: '', u: 'https://a.example/x' }, { t: '仿單', u: 'https://b.example/y' }]);
assert.equal(citationKey('PMID: 31632624'), 'PMID31632624');
assert.equal(citationKey('https://pubmed.ncbi.nlm.nih.gov/31632624/'), 'PMID31632624');
assert.equal(citationKey('PMC10447584'), 'PMC10447584');
assert.ok(titlesMatch(PIM, `${PIM}.`));
assert.ok(!titlesMatch(PIM, 'Thanks to Partners, Sponsors and Exhibitors.'));
assert.equal(sameWording('a（PMID:1234567）b', 'a（PMID:7654321）b'), 1, 'numbers do not count as wording');
console.log('citation fix checks passed');
