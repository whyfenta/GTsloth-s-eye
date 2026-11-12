import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { closed, done, mergeVotes, preReviewer, proposalItem, reviewerId, splitVotes, stale, tally, teamState, teamStatus, voteRequest, REVIEW_FORMAT, type Item, type Vote } from '../src/review-model';
import { proposalProblems, proposalsCsv, proposalsOfRows, publishedProposals, PROPOSAL_COLUMNS, PROPOSALS_FORMAT, type Proposal } from '../src/rx-proposals';

// The review page's model, the weekly proposals, and docs/rx-review-apps-script.gs run against small fakes of the Google services.
const item = (changes: Partial<Item> = {}): Item => ({ id: 'C56', table: 'cautions', batch: '2026-11-10', changed: '2026-11-10T00:00:00.000Z', basis: 'Beers 2023 表 3', flags: [], hits: null, ...changes });
const vote = (d: Vote['d'], t = '2026-11-11T01:00:00.000Z', c = ''): Vote => ({ d, c, t });

// A decision counts only if it was made after the rule last changed; a closed item needs nobody.
assert.equal(done(item(), undefined), false);
assert.equal(done(item(), vote('同意')), true);
assert.equal(done(item(), vote('', '2026-11-11T01:00:00.000Z', '只寫意見')), false);
assert.equal(stale(item(), vote('同意', '2026-11-09T00:00:00.000Z')), true);
assert.equal(done(item(), vote('同意', '2026-11-09T00:00:00.000Z')), false);
assert.equal(closed(item({ approved: { at: '2026-11-12', n: 2 } })), true);
assert.equal(done(item({ outcome: '依意見改成灰色' }), undefined), true);

// The team: enough agree and nobody objects → 達門檻; one objection or opinion → 有分歧; stale votes are not counted.
const votes = { a: vote('同意'), b: vote('同意', '2026-11-11T02:00:00.000Z', '同意，但提示可以短一點') };
assert.equal(teamStatus(item(), {}, 2), '未審');
assert.equal(teamStatus(item(), { a: vote('同意') }, 2), '審核中');
assert.equal(teamStatus(item(), votes, 2), '達門檻');
assert.equal(teamStatus(item(), votes, 3), '審核中');
assert.equal(teamStatus(item(), { ...votes, c: vote('其他意見') }, 2), '有分歧');
assert.equal(teamStatus(item(), { ...votes, c: vote('不同意') }, 2), '有分歧');
assert.equal(teamStatus(item(), { a: vote('同意'), b: vote('同意', '2026-11-01T00:00:00.000Z') }, 2), '審核中', 'a vote from before the change does not count');
assert.equal(teamStatus(item({ approved: { at: '2026-11-12', n: 2 } }), { c: vote('不同意') }, 2), '已結案');
assert.equal(teamStatus(item(), { a: vote('同意') }, 0), '達門檻', 'a quorum below 1 is 1');
assert.deepEqual(tally(item(), votes), { 同意: ['a', 'b'], 不同意: [], 其他意見: [], comments: [{ who: 'b', d: '同意', c: '同意，但提示可以短一點' }] });

// An AI pre-review (name contains 預審) is kept apart: its opinion makes no split, its agreement does not reach the quorum.
assert.deepEqual([preReviewer('Codex-Sol預審'), preReviewer('王藥師'), preReviewer(undefined)], [true, false, false]);
const names: Record<string, string> = { a: '王藥師', b: '李藥師', x: 'Codex-Sol預審' };
const withPre = splitVotes({ a: vote('同意'), x: vote('其他意見', undefined, 'AI 預審：需補原文') }, who => preReviewer(names[who]));
assert.deepEqual(Object.keys(withPre.team), ['a']);
assert.deepEqual(Object.keys(withPre.pre), ['x']);
assert.equal(teamStatus(item(), withPre.team, 2), '審核中', 'the pre-review opinion is not a split');
assert.equal(teamStatus(item(), splitVotes({ a: vote('同意'), x: vote('同意') }, who => preReviewer(names[who])).team, 2), '審核中', 'nor does its agreement count toward the quorum');

// Two devices of one reviewer: the later vote stands on each item.
assert.deepEqual(mergeVotes({ C56: vote('不同意', '2026-11-11T03:00:00.000Z'), C57: vote('同意', '2026-11-11T00:00:00.000Z') }, { C57: vote('其他意見', '2026-11-11T05:00:00.000Z'), C58: vote('同意') }),
  { C56: vote('不同意', '2026-11-11T03:00:00.000Z'), C57: vote('其他意見', '2026-11-11T05:00:00.000Z'), C58: vote('同意') });
assert.match(reviewerId(), /^[0-9a-z]{16}$/);
assert.notEqual(reviewerId(), reviewerId());

// What the network answers is checked before it is used.
assert.deepEqual(teamState(null), { error: '回應格式不對' });
assert.deepEqual(teamState({ ok: false, error: 'code' }), { error: '團隊代碼不對' });
const answered = teamState({ ok: true, quorum: 3, reviewers: { a: '王藥師', b: 7 }, votes: { C56: { a: vote('同意'), b: { d: '亂寫', c: '', t: '' } }, C57: 'x' }, proposals: 'x' });
assert.deepEqual(answered, { quorum: 3, reviewers: { a: '王藥師' }, votes: { C56: { a: vote('同意') } }, proposals: [], skipped: 0, proposalProblem: '' });
assert.equal((teamState({ ok: true, proposalProblem: '沒有 Drive 權限' }) as { proposalProblem: string }).proposalProblem, '沒有 Drive 權限');
assert.equal((teamState({ ok: true }) as { quorum: number }).quorum, 2);

// Proposals: ids, kinds, a rule's row, evidence; and nothing from a sample.
const proposal = (changes: Partial<Proposal> = {}): Proposal => ({ id: 'P20261116-01', kind: '新增規則', title: 'Pentoxifylline 配慢性腎病', file: 'indications',
  row: 'C04AD03,Pentoxifylline,N18 E11.2,常見仿單外,蛋白尿', evidence: '7 次、4 家院所；同時出現的診斷 N18 ×4', basis: '常見仿單外（待藥師判斷）', trial: '灰→無提示 3 張，沒有其他改變', note: '', ...changes });
assert.deepEqual(proposalProblems(proposal()), []);
assert.deepEqual(proposalProblems(proposal({ kind: '資料品質', file: '', row: '', trial: '', title: '某院所的 4 碼科別被截成 2 碼' })), []);
const problemOf = (changes: Partial<Proposal>) => proposalProblems(proposal(changes)).join('；');
assert.match(problemOf({ id: 'P1' }), /編號/);
assert.match(problemOf({ kind: '隨便' as Proposal['kind'] }), /類型/);
assert.match(problemOf({ file: 'rules' }), /檔案/);
assert.match(problemOf({ row: '' }), /整列內容/);
assert.match(problemOf({ evidence: '' }), /證據/);
assert.match(problemOf({ trial: '' }), /試跑/);
assert.match(problemOf({ evidence: '行 12：0000000000;2;04;;SEXM;AGE70-79;AB;1151101;;28;A12;E119#;;;TESTCODE01;1;QD;PO;28;' }), /樣本行/);
assert.match(problemOf({ evidence: '院所 0000000000 有 3 張' }), /院所代碼/);
assert.match(problemOf({ note: '那張是 AGE70-79 的女性' }), /年齡層/);
assert.match(problemOf({ title: 'x'.repeat(121) }), /超過 120 字/);
assert.match(problemOf({ note: '第一行\n第二行' }), /換行/);
assert.throws(() => proposalsCsv([proposal(), proposal()]), /編號重複/);
assert.throws(() => proposalsCsv([proposal({ evidence: '' })]), /P20261116-01：沒有證據/);
// The CSV and back: quotes around a row with commas, an apostrophe before what a sheet would read as a formula or a number.
const csv = proposalsCsv([proposal(), proposal({ id: 'P20261116-02', kind: '待決定', file: '', row: '', trial: '', title: '=開頭的標題', evidence: '12' })]);
assert.equal(csv.split('\n')[0], PROPOSAL_COLUMNS.join(','));
assert.ok(csv.includes('"C04AD03,Pentoxifylline,N18 E11.2,常見仿單外,蛋白尿"'));
assert.ok(csv.includes("'=開頭的標題") && csv.includes(",'12,"));
const rows = [[...PROPOSAL_COLUMNS], ['P20261116-01', '新增規則', 'Pentoxifylline 配慢性腎病', 'indications', 'C04AD03,Pentoxifylline,N18 E11.2,常見仿單外,蛋白尿', '7 次、4 家院所', '常見仿單外', '灰→無提示 3 張', ''],
  ['P20261116-02', '待決定', "'=開頭的標題", '', '', '12', '待藥師判斷', '', ''], ['亂寫', '', '', '', '', '', '', '', ''], ['', '', '', '', '', '', '', '', '']];
const back = proposalsOfRows(rows);
assert.deepEqual([back.proposals.map(p => p.id), back.skipped, back.proposals[1].title], [['P20261116-01', 'P20261116-02'], 1, '=開頭的標題']);
assert.deepEqual(proposalsOfRows('x'), { proposals: [], skipped: 0 });
const asItem = proposalItem(back.proposals[0]);
assert.deepEqual([asItem.table, asItem.batch, closed(asItem), done(asItem, vote('同意', '2020-01-01T00:00:00.000Z'))], ['proposals', '20261116', false, true]);
assert.equal(proposalItem(back.proposals[0], { status: '已採用', decided: '2026-11-18', note: '加成 I97' }).outcome, '已採用（2026-11-18）：加成 I97');

// The proposals published with the site: every one could be published again, none twice, none already closed without the ledger saying so.
const publishedFile = JSON.parse(readFileSync('public/assets/rx/proposals.json', 'utf8'));
const publishedList = publishedProposals(publishedFile);
assert.equal(publishedFile.format, PROPOSALS_FORMAT);
assert.equal(publishedList.length, publishedFile.proposals.length, 'public/assets/rx/proposals.json 有不能發布的提案：請用 npm run rx-proposals -- --publish 重產');
assert.equal(new Set(publishedList.map(p => p.id)).size, publishedList.length, '提案編號重複');
assert.deepEqual(publishedProposals({ format: PROPOSALS_FORMAT, proposals: [proposal(), { ...proposal(), id: 'P20261116-02', evidence: '院所 0000000000 有 3 張' }, null] }).map(p => p.id), ['P20261116-01']);
assert.deepEqual(publishedProposals({ format: 'x', proposals: [proposal()] }), []);

// The team's sheet.
type Row = string[];
class FakeSheet {
  rows: Row[] = [];
  constructor(public name: string) {}
  getName() { return this.name; }
  setName(name: string) { this.name = name; }
  getLastRow() { let n = this.rows.length; while (n && !this.rows[n - 1].some(Boolean)) n--; return n; }
  setFrozenRows() {}
  deleteRows(at: number, count: number) { this.rows.splice(at - 1, count); }
  getDataRange() { const values = () => this.rows.slice(0, this.getLastRow()).map(row => [...row]); return { getValues: values, getDisplayValues: values }; }
  getRange(row: number, column: number, rows = 1, columns = 1) {
    const range = {
      setNumberFormat: () => range,
      setValues: (values: unknown[][]) => {
        assert.equal(values.length, rows); values.forEach(value => assert.equal(value.length, columns));
        values.forEach((value, i) => { const target = this.rows[row - 1 + i] ??= []; value.forEach((v, j) => { target[column - 1 + j] = String(v); }); });
        return range;
      },
      clearContent: () => { for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) if (this.rows[row - 1 + i]) this.rows[row - 1 + i][column - 1 + j] = ''; return range; },
    };
    return range;
  }
}
function load() {
  const sheets: FakeSheet[] = [new FakeSheet('工作表1')];
  const properties: Record<string, string> = {}, cache: Record<string, string> = {};
  const proposalSheets: { id: string; name: string; sheet: FakeSheet }[] = [];
  const weekly = { getFilesByType: () => { const left = [...proposalSheets]; return { hasNext: () => left.length > 0, next: () => { const file = left.shift()!; return { getName: () => file.name, getId: () => file.id }; } }; } };
  const root = { getFoldersByName: (name: string) => { let used = name !== '每週檢查'; return { hasNext: () => !used, next: () => { used = true; return weekly; } }; } };
  const book = {
    getId: () => 'BOOK', getSheets: () => sheets, getSheetByName: (name: string) => sheets.find(s => s.name === name) ?? null,
    insertSheet: (name: string) => { const created = new FakeSheet(name); sheets.push(created); return created; },
    setActiveSheet: (sheet: FakeSheet) => { active = sheet; },
    moveActiveSheet: (position: number) => { sheets.splice(sheets.indexOf(active!), 1); sheets.splice(position - 1, 0, active!); },
  };
  let active: FakeSheet | undefined;
  const logs: string[] = [], asked: string[] = [];
  const drive = { denied: false };
  let uuid = 0;
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: (id: string) => ({ getSheets: () => [proposalSheets.find(file => file.id === id)!.sheet] }) },
    DriveApp: { getFileById: () => { if (drive.denied) throw new Error('You do not have permission to call DriveApp.getFileById'); return { getParents: () => ({ next: () => root }) }; } },
    ScriptApp: { AuthMode: { FULL: 'FULL' }, requireAllScopes: (mode: string) => { asked.push(mode); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (name: string) => properties[name] ?? null, setProperty: (name: string, value: string) => { properties[name] = value; } }) },
    CacheService: { getScriptCache: () => ({ get: (key: string) => cache[key] ?? null, put: (key: string, value: string) => { cache[key] = value; }, remove: (key: string) => { delete cache[key]; } }) },
    Utilities: { formatDate: () => '2026-11-11 09:00:00', getUuid: () => `${String(++uuid).padStart(8, '0')}-1a2b-3c4d-5e6f-778899aabbcc` },
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: (text: string) => ({ setMimeType: () => text }), MimeType: { JSON: 'JSON' } },
    MimeType: { GOOGLE_SHEETS: 'sheets' },
    Logger: { log: (text: string) => logs.push(text) },
  });
  vm.runInContext(readFileSync('docs/rx-review-apps-script.gs', 'utf8'), context);
  const call = <T>(name: string, ...args: unknown[]) => (vm.runInContext(name, context) as (...a: unknown[]) => T)(...args);
  const addProposals = (name: string, values: Row[]) => { const sheet = new FakeSheet(name); sheet.rows = values; proposalSheets.push({ id: `P${proposalSheets.length}`, name, sheet }); delete cache.state; };
  return { call, sheets, properties, logs, asked, drive, cache, addProposals, sheet: (name: string) => sheets.find(s => s.name === name)! };
}
const gs = load();
const get = (code?: string) => JSON.parse(gs.call<string>('doGet', { parameter: code === undefined ? {} : { code } }));
const post = (record: unknown) => JSON.parse(gs.call<string>('doPost', { postData: { contents: typeof record === 'string' ? record : JSON.stringify(record) } }));

// Before setup() there is no code, so nobody gets in, whatever they send.
assert.deepEqual(get(''), { ok: false, error: 'code' });
assert.deepEqual(get(), { ok: false, error: 'code' });
gs.call('setup'); gs.call('setup');
assert.deepEqual(gs.sheets.map(s => s.name), ['統計', '票', '審核者'], '統計 is the first sheet, however often setup() runs');
const code = gs.properties.TEAM_CODE;
assert.match(code, /^[0-9a-z]{16}$/);
assert.equal(gs.logs.filter(line => line.includes(code)).length, 2, 'setup() run again keeps the code');
assert.deepEqual(get('wrongwrongwrong1'), { ok: false, error: 'code' });
assert.deepEqual(get(code), { ...get(code), ok: true, quorum: 2, reviewers: {}, votes: {}, proposals: [], proposalProblem: '' });
assert.deepEqual(gs.asked, ['FULL', 'FULL'], 'setup() asks for every permission the script uses');
assert.ok(gs.logs.some(line => line === '提案表：讀得到 0 份'));

// The page's own request is what the script accepts.
const wang = { id: 'aaaaaaaaaaaaaaaa', name: '王藥師' }, lee = { id: 'bbbbbbbbbbbbbbbb', name: '李藥師' };
const request = voteRequest(code, wang, { C56: vote('同意'), C57: vote('不同意', '2026-11-11T01:05:00.000Z', '=不同意：國內仿單沒有這條') });
assert.equal(request.format, REVIEW_FORMAT);
assert.deepEqual(post(request), { ok: true, saved: 2 });
assert.deepEqual(post(voteRequest(code, lee, { C56: vote('同意', '2026-11-11T02:00:00.000Z'), P1: vote('其他意見', '2026-11-11T02:00:00.000Z', '需要更多樣本') })), { ok: true, saved: 2 });
let state = get(code);
assert.deepEqual(state.reviewers, { [wang.id]: '王藥師', [lee.id]: '李藥師' });
assert.deepEqual(state.votes.C56, { [wang.id]: vote('同意'), [lee.id]: vote('同意', '2026-11-11T02:00:00.000Z') });
assert.equal(state.votes.C57[wang.id].c, '=不同意：國內仿單沒有這條', 'a comment that looks like a formula comes back as written');
assert.equal(gs.sheet('票').rows[2][5], "'=不同意：國內仿單沒有這條", 'and is stored so the sheet does not run it');
const read = teamState(state);
assert.ok(!('error' in read));
assert.equal(teamStatus(item(), read.votes.C56, read.quorum), '達門檻');
assert.equal(teamStatus(item({ id: 'C57' }), read.votes.C57, read.quorum), '有分歧');

// A later vote replaces the earlier one in place; an older copy does not undo it; a cleared vote disappears; a new name follows.
assert.deepEqual(post(voteRequest(code, { ...wang, name: '王大明藥師' }, { C56: vote('其他意見', '2026-11-11T03:00:00.000Z', '改灰色') })), { ok: true, saved: 1 });
assert.deepEqual(post(voteRequest(code, wang, { C56: vote('同意') })), { ok: true, saved: 0 });
assert.deepEqual(post(voteRequest(code, lee, { P1: vote('', '2026-11-11T04:00:00.000Z') })), { ok: true, saved: 1 });
state = get(code);
assert.equal(gs.sheet('票').rows.length, 5, 'one row per reviewer and item');
assert.deepEqual(state.votes.C56[wang.id], vote('其他意見', '2026-11-11T03:00:00.000Z', '改灰色'));
assert.equal(state.votes.P1, undefined);
assert.equal(state.reviewers[wang.id], '王藥師', 'the older copy came last, so its name stands');
// 統計: one row per item with a decision or a comment.
assert.deepEqual(gs.sheet('統計').rows.slice(1).filter(row => row[0]).map(row => row.slice(0, 6)),
  [['C56', '1', '0', '1', '王藥師：其他意見、李藥師：同意', '王藥師：改灰色'], ['C57', '0', '1', '0', '王藥師：不同意', '王藥師：=不同意：國內仿單沒有這條']]);
// An AI pre-review gets its own column on 統計 and changes none of the counts.
const codex = { id: 'cccccccccccccccc', name: 'Codex-Sol預審' };
assert.deepEqual(post(voteRequest(code, codex, { C57: vote('其他意見', '2026-11-11T05:00:00.000Z', 'AI 預審：需補國內仿單'), C58: vote('同意', '2026-11-11T05:00:00.000Z') })), { ok: true, saved: 2 });
assert.deepEqual(gs.sheet('統計').rows[0], ['項目', '同意', '不同意', '其他意見', '審核者與決定', '意見', '最近一次', 'AI 預審（不計票）']);
assert.deepEqual(gs.sheet('統計').rows.slice(1).filter(row => row[0]).map(row => [row[0], row[1], row[2], row[3], row[4], row[7]]),
  [['C56', '1', '0', '1', '王藥師：其他意見、李藥師：同意', ''], ['C57', '0', '1', '0', '王藥師：不同意', 'Codex-Sol預審（其他意見）：AI 預審：需補國內仿單'], ['C58', '0', '0', '0', '', 'Codex-Sol預審（同意）：']]);
const preRead = teamState(get(code));
assert.ok(!('error' in preRead));
assert.equal(teamStatus(item({ id: 'C58' }), splitVotes(preRead.votes.C58, who => preReviewer(preRead.reviewers[who])).team, preRead.quorum), '未審');
// Take the pre-review out again, so the rest of this test sees the sheet as before.
assert.deepEqual(post(voteRequest(code, codex, { C57: vote('', '2026-11-11T06:00:00.000Z'), C58: vote('', '2026-11-11T06:00:00.000Z') })), { ok: true, saved: 2 });

// Anything else is turned down, and nothing is written.
const written = gs.sheet('票').rows.length;
for (const [record, reason] of [
  [{ ...request, code: 'wrongwrongwrong1' }, 'code'], [{ ...request, version: 2 }, 'format'], [{ ...request, format: 'gtsloth-rx-samples' }, 'format'],
  [{ ...request, reviewer: { id: 'short', name: '王' } }, 'reviewer'], [{ ...request, reviewer: { id: wang.id, name: ' ' } }, 'name'], [{ ...request, reviewer: { id: wang.id, name: 'x'.repeat(31) } }, 'name'],
  [{ ...request, votes: [] }, 'votes'], [{ ...request, votes: Array(201).fill(request.votes[0]) }, 'votes'], [{ ...request, votes: [{ ...request.votes[0], id: 'C56;DROP' }] }, 'item'],
  [{ ...request, votes: [{ ...request.votes[0], d: '批准' }] }, 'decision'], [{ ...request, votes: [{ ...request.votes[0], c: 'x'.repeat(1001) }] }, 'comment'],
  [{ ...request, votes: [{ ...request.votes[0], t: '昨天' }] }, 'time'], ['{', 'error'], ['x'.repeat(200001), 'size'],
] as [unknown, string][]) assert.deepEqual(post(record), { ok: false, error: reason });
assert.equal(gs.sheet('票').rows.length, written);

// The weekly proposals: sheets named 週檢查_YYYYMMDD（提案） in 每週檢查, newest first; other files are left alone.
gs.addProposals('週檢查_20261109（提案）', [[...PROPOSAL_COLUMNS], ['P20261109-01', '資料品質', '4 碼科別被截成 2 碼', '', '', '1 家院所、6 張', '待藥師判斷', '', '']]);
gs.addProposals('週檢查_20261116（提案）', rows);
gs.addProposals('週檢查_20261116（審閱）', [['不是提案']]);
state = get(code);
assert.deepEqual(state.proposals.map((sheet: { week: string }) => sheet.week), ['20261116', '20261109']);
const proposed = teamState(state);
assert.ok(!('error' in proposed));
assert.deepEqual([proposed.proposals.map(p => p.id), proposed.skipped], [['P20261116-01', 'P20261116-02', 'P20261109-01'], 1]);

// Without the Drive permission the votes still work and the answer says why there are no proposals; checkProposals() says so too.
gs.drive.denied = true; delete gs.cache.state;
state = get(code);
assert.deepEqual([state.ok, state.proposals, Object.keys(state.votes).length > 0], [true, [], true]);
assert.match(state.proposalProblem, /do not have permission/);
assert.throws(() => gs.call('checkProposals'), /讀不到提案表：You do not have permission/);
gs.drive.denied = false;
assert.equal(gs.call('checkProposals'), 2);
assert.ok(gs.logs.some(line => line === '提案表 2 份（20261116、20261109），共 4 項'));
assert.equal(get(code).proposalProblem, '');

// selfTest() leaves nothing behind; resetCode() shuts the old link out.
gs.call('selfTest');
assert.equal(gs.sheet('票').rows.length, written);
assert.ok(!gs.sheet('審核者').rows.some(row => row[0] === 'selftest00000000'));
gs.call('resetCode');
assert.deepEqual(get(code), { ok: false, error: 'code' });
assert.equal(get(gs.properties.TEAM_CODE).ok, true);
console.log('review team model, weekly proposals and the team sheet script passed');
