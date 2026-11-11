/**
 * 處方警示 · 規則審核的團隊共用儲存（Google Apps Script，綁定在試算表「GTsloth 規則審核（團隊）」上）。
 * 審核頁（review/，src/review.ts）用 GET 讀全部審核者的決定與每週檢查的提案，用 POST 存一位審核者的決定。
 * 讀寫都要帶團隊代碼：代碼存在指令碼屬性 TEAM_CODE，只出現在負責人分享的連結裡，不在公開的程式或 repo。
 * 這裡只存「誰對哪一條規則選了什麼、寫了什麼意見」，沒有任何處方或病人資料。
 * 決定不會自動改規則：負責人請 Claude 讀「統計」分頁，依 docs/reference/rx-rules.md「審核頁」結案。
 * 設定步驟見 README「規則審核頁」。
 */
const FORMAT = 'gtsloth-rx-review';
const MAX_BYTES = 200000;
const MAX_VOTES = 200;
const CHOICES = ['同意', '不同意', '其他意見', ''];
const VOTES = ['收到時間', '審核者編號', '審核者', '項目', '決定', '意見', '決定時間'];
const REVIEWERS = ['審核者編號', '審核者', '第一次', '最近一次'];
const STATS = ['項目', '同意', '不同意', '其他意見', '審核者與決定', '意見', '最近一次'];
const PROPOSAL_FOLDER = '每週檢查';
const PROPOSAL_NAME = /^(?:週檢查|指引確認)_(\d{8})（提案）$/;
/** How many weeks of proposal sheets a read returns, newest first. */
const PROPOSAL_WEEKS = 12;
const DEFAULT_QUORUM = 2;

function doGet(e) {
  try {
    const params = e && e.parameter || {};
    if (!codeOk(params.code)) return json({ ok: false, error: 'code' });
    return json(state());
  } catch (error) {
    return json({ ok: false, error: 'error' });
  }
}
function doPost(e) {
  try {
    const text = e && e.postData && e.postData.contents || '';
    if (!text || text.length > MAX_BYTES) return json({ ok: false, error: 'size' });
    const record = JSON.parse(text);
    if (!record || record.format !== FORMAT || record.version !== 1) return json({ ok: false, error: 'format' });
    if (!codeOk(record.code)) return json({ ok: false, error: 'code' });
    const problem = recordProblem(record);
    if (problem) return json({ ok: false, error: problem });
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try { return json({ ok: true, saved: write(record) }); } finally { lock.releaseLock(); }
  } catch (error) {
    return json({ ok: false, error: 'error' });
  }
}

const property = name => PropertiesService.getScriptProperties().getProperty(name) || '';
/** The team's code: set by setup(), 12 to 40 letters and digits. No code set means nobody gets in. */
function codeOk(code) {
  const expected = property('TEAM_CODE');
  return typeof code === 'string' && /^[0-9A-Za-z]{12,40}$/.test(expected) && code === expected;
}
function quorum() {
  const n = parseInt(property('QUORUM'), 10);
  return n >= 1 && n <= 20 ? n : DEFAULT_QUORUM;
}
const plain = (text, max) => typeof text === 'string' && text.length <= max && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text);
function recordProblem(record) {
  const who = record.reviewer;
  if (!who || typeof who.id !== 'string' || !/^[0-9a-z]{16}$/.test(who.id)) return 'reviewer';
  if (!plain(who.name, 30) || !who.name.trim() || /[\r\n]/.test(who.name)) return 'name';
  if (!Array.isArray(record.votes) || !record.votes.length || record.votes.length > MAX_VOTES) return 'votes';
  for (const vote of record.votes) {
    if (!vote || typeof vote.id !== 'string' || !/^[0-9A-Za-z-]{1,24}$/.test(vote.id)) return 'item';
    if (CHOICES.indexOf(vote.d) < 0) return 'decision';
    if (!plain(vote.c, 1000)) return 'comment';
    if (typeof vote.t !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(vote.t)) return 'time';
  }
  return '';
}

/** One row per reviewer and item: a later vote replaces the earlier one in place. Returns how many votes were written. */
function write(record) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const votes = sheet(book, '票', VOTES); const reviewers = sheet(book, '審核者', REVIEWERS);
  const now = stamp(new Date());
  const who = record.reviewer; const name = cell(who.name.trim(), 30);
  const rows = votes.getDataRange().getValues().slice(1).map(row => row.map(String));
  const at = {};
  rows.forEach((row, i) => { at[row[1] + '|' + row[3]] = i; });
  const added = [];
  let saved = 0;
  for (const vote of record.votes) {
    const row = [now, who.id, name, vote.id, vote.d, cell(vote.c, 1000), vote.t];
    const index = at[who.id + '|' + vote.id];
    if (index === undefined) { at[who.id + '|' + vote.id] = rows.length + added.length; added.push(row); saved++; continue; }
    const target = index < rows.length ? rows[index] : added[index - rows.length];
    // An older copy of a vote (a second device catching up) does not undo a newer one.
    if (target[6] && target[6] > vote.t) continue;
    if (index < rows.length) { rows[index] = row; votes.getRange(index + 2, 1, 1, row.length).setNumberFormat('@').setValues([row]); }
    else added[index - rows.length] = row;
    saved++;
  }
  append(votes, added);
  const people = reviewers.getDataRange().getValues().slice(1).map(row => row.map(String));
  const known = people.findIndex(row => row[0] === who.id);
  if (known < 0) append(reviewers, [[who.id, name, now, now]]);
  else reviewers.getRange(known + 2, 2, 1, 3).setNumberFormat('@').setValues([[name, people[known][2], now]]);
  rebuildStats(book, rows.concat(added), names(reviewers));
  CacheService.getScriptCache().remove('state');
  return saved;
}
/** Each reviewer's name as they last gave it. */
function names(reviewers) {
  const map = {};
  for (const row of reviewers.getDataRange().getValues().slice(1)) map[String(row[0])] = String(row[1]);
  return map;
}
/** 「統計」: one row per item, for the owner and for Claude to read. Rewritten whole on every save. */
function rebuildStats(book, rows, who) {
  const items = {};
  for (const row of rows) {
    const item = items[row[3]] || (items[row[3]] = { 同意: 0, 不同意: 0, 其他意見: 0, who: [], comments: [], last: '' });
    const name = who[row[1]] || row[2];
    if (row[4]) { item[row[4]]++; item.who.push(name + '：' + row[4]); }
    if (row[5]) item.comments.push(name + '：' + row[5].replace(/^'/, ''));
    if (row[6] > item.last) item.last = row[6];
  }
  const out = Object.keys(items).sort().filter(id => items[id].who.length || items[id].comments.length)
    .map(id => [id, String(items[id].同意), String(items[id].不同意), String(items[id].其他意見), cell(items[id].who.join('、'), 2000), cell(items[id].comments.join(' ／ '), 8000), items[id].last]);
  const stats = sheet(book, '統計', STATS);
  if (stats.getLastRow() > 1) stats.getRange(2, 1, stats.getLastRow() - 1, STATS.length).clearContent();
  if (out.length) stats.getRange(2, 1, out.length, STATS.length).setNumberFormat('@').setValues(out);
}

/** Everything the page shows that is not in the repo: who the reviewers are, every vote, and the weekly proposals. */
function state() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('state');
  if (cached) return JSON.parse(cached);
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const reviewers = names(sheet(book, '審核者', REVIEWERS)); const votes = {};
  for (const row of sheet(book, '票', VOTES).getDataRange().getValues().slice(1).map(values => values.map(String))) {
    if (!row[4] && !row[5]) continue;
    (votes[row[3]] || (votes[row[3]] = {}))[row[1]] = { d: row[4], c: row[5].replace(/^'/, ''), t: row[6] };
  }
  const result = { ok: true, quorum: quorum(), reviewers, votes, proposals: proposals(), time: new Date().toISOString() };
  const text = JSON.stringify(result);
  // The cache holds 100 KB a key; a larger answer is simply built again on the next read.
  if (text.length < 90000) cache.put('state', text, 60);
  return result;
}
/** The proposal sheets left in 每週檢查 by the weekly review (週檢查_YYYYMMDD（提案）) and the source check (指引確認_…), newest first, as displayed rows. */
function proposals() {
  const out = [];
  try {
    const parent = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents().next();
    const folders = parent.getFoldersByName(PROPOSAL_FOLDER);
    if (!folders.hasNext()) return out;
    const files = folders.next().getFilesByType(MimeType.GOOGLE_SHEETS);
    const found = [];
    while (files.hasNext()) { const file = files.next(); const match = PROPOSAL_NAME.exec(file.getName()); if (match) found.push({ week: match[1], id: file.getId() }); }
    found.sort((a, b) => a.week < b.week ? 1 : -1);
    for (const item of found.slice(0, PROPOSAL_WEEKS)) {
      const rows = SpreadsheetApp.openById(item.id).getSheets()[0].getDataRange().getDisplayValues();
      out.push({ week: item.week, rows: rows.slice(0, 60).map(row => row.slice(0, 9).map(value => String(value).slice(0, 1500))) });
    }
  } catch (error) { /* a folder this script cannot read gives no proposals; the votes still work */ }
  return out;
}

/**
 * Run once from the editor: the three sheets and the team's code. Running it again keeps the code.
 * The execution log shows what to add to the review page's address: ?code=…
 */
function setup() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const first = book.getSheets()[0];
  if (book.getSheets().length === 1 && first.getName() !== '票' && first.getLastRow() === 0) first.setName('票');
  sheet(book, '票', VOTES); sheet(book, '審核者', REVIEWERS);
  // 統計 comes first: a reader that only sees a spreadsheet's first sheet (the weekly review through Drive) gets the tally.
  try { book.setActiveSheet(sheet(book, '統計', STATS)); book.moveActiveSheet(1); } catch (error) { /* the order is a convenience */ }
  const properties = PropertiesService.getScriptProperties();
  if (!codeOk(properties.getProperty('TEAM_CODE'))) properties.setProperty('TEAM_CODE', newCode());
  if (!properties.getProperty('QUORUM')) properties.setProperty('QUORUM', String(DEFAULT_QUORUM));
  Logger.log('團隊代碼：' + properties.getProperty('TEAM_CODE') + '（分享連結：審核頁網址加上 ?code=這串代碼）');
  Logger.log('結案門檻：' + quorum() + ' 位同意且無人反對（改指令碼屬性 QUORUM）');
}
/** Run from the editor to replace the team's code: every link shared before stops working. */
function resetCode() {
  PropertiesService.getScriptProperties().setProperty('TEAM_CODE', newCode());
  CacheService.getScriptCache().remove('state');
  Logger.log('新的團隊代碼：' + property('TEAM_CODE'));
}
function newCode() {
  const letters = 'abcdefghijkmnpqrstuvwxyz23456789';
  let code = '';
  for (const byte of Utilities.getUuid().replace(/-/g, '').match(/../g)) code += letters[parseInt(byte, 16) % letters.length];
  return code.slice(0, 16);
}
/** Run from the editor after setup(): saves one vote as a test reviewer, reads it back, removes it. */
function selfTest() {
  const id = 'selftest00000000';
  const record = { format: FORMAT, version: 1, code: property('TEAM_CODE'), reviewer: { id, name: '自我測試' }, votes: [{ id: 'SELFTEST', d: '同意', c: '測試', t: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }] };
  const problem = recordProblem(record);
  if (problem) throw new Error('recordProblem: ' + problem);
  if (!codeOk(record.code)) throw new Error('還沒有團隊代碼，請先執行 setup');
  write(record);
  const back = state().votes.SELFTEST;
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const votes = book.getSheetByName('票'); const reviewers = book.getSheetByName('審核者');
  const drop = (target, column) => { const values = target.getDataRange().getValues(); for (let i = values.length - 1; i >= 1; i--) if (String(values[i][column]) === id) target.deleteRows(i + 1, 1); };
  drop(votes, 1); drop(reviewers, 0);
  rebuildStats(book, votes.getDataRange().getValues().slice(1).map(row => row.map(String)), names(reviewers));
  CacheService.getScriptCache().remove('state');
  if (!back || !back[id] || back[id].d !== '同意') throw new Error('寫入後讀回不同');
  Logger.log('selfTest ok');
}

function sheet(book, name, header) {
  let target = book.getSheetByName(name);
  if (!target) target = book.insertSheet(name);
  if (target.getLastRow() === 0) { target.getRange(1, 1, 1, header.length).setValues([header]); target.setFrozenRows(1); }
  return target;
}
/** Rows go in as plain text, so nothing is read as a number, date or formula. */
function append(target, rows) {
  if (rows.length) target.getRange(target.getLastRow() + 1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
}
/** Text from the page is data: cut to a sane length, and never let it start a formula. */
function cell(value, max) {
  if (value === undefined || value === null) return '';
  const text = String(value).slice(0, max || 500);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}
const stamp = date => Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
const json = data => ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
