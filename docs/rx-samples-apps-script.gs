/**
 * 處方警示 · 處方樣本接收端與每週整理（Google Apps Script，綁定在「GTsloth 掃碼樣本（自動收集）」試算表上）。
 * 憑單頁列印時 POST 一份 gtsloth-rx-samples JSON（src/rx-sample.ts）：每張處方是收集頁同格式的去識別化行，附上當時規則的判定摘要。
 * 這裡逐行再檢查一次去識別化，合格的寫進「樣本」，其餘只在「失敗」記原因、不記內容。
 * 每週一 weekly()：與先前的行比對去掉重複，把不重複的行匯出成 .txt 到同資料夾的「驗證用」，
 * 並在「每週檢查」寫一份「週檢查資料_日期」文件給每週檢查（docs/rx-samples-weekly-review.md）讀。
 * 「對照檔查無」「合併多出」兩欄在最後，舊的試算表在下一次寫入時自動補上欄名，舊的列留白。
 * 設定步驟見 README「處方樣本試算表」。
 */
const FORMAT = 'gtsloth-rx-samples';
const MAX_BYTES = 100000;
const MAX_PRESCRIPTIONS = 20;
const MAX_FAILED = 50;
const MAX_LINE = 8000;
const SAMPLES = ['收到時間', '送出時間', '程式版本', '規則版本', '批次', 'QR數', '醫事機構代碼', '科別', '年齡層', '性別', '診斷碼', '藥品數',
  '最高等級', '警示', '注意事項', '未解釋', '查無藥品', '查無診斷', '去識別化內容', '內容摘要', '重複於', '匯出檔', '對照檔查無', '合併多出'];
const FAILURES = ['收到時間', '程式版本', '批次', '內容', '整理'];
const WEEKS = ['整理時間', '起日', '訖日', '新增張數', '重複', '失敗', '院所數', '新院所', '紅', '黃', '黃紅比例', '規則版本', '匯出檔', '檢查資料'];
const VALIDATION_FOLDER = '驗證用';
const REVIEW_FOLDER = '每週檢查';
const SEP = ' | ';
const UNCHECKED = '（未判定）';
/** How much of each list the weekly summary prints. */
const LIMITS = { flagged: 150, atcs: 60, examples: 3, codes: 80, patients: 60 };
/** 樹懶的算數「批次蒐集」sends one patient's prescriptions in a request of their own, with this after the app version: one 批次, one patient. */
const SAME_PATIENT = ' 同一病人';

function doPost(e) {
  try {
    const text = e && e.postData && e.postData.contents || '';
    if (!text || text.length > MAX_BYTES) return reply('rejected: size');
    const record = JSON.parse(text);
    const problem = recordProblem(record);
    if (problem) return reply('rejected: ' + problem);
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try { write(record); } finally { lock.releaseLock(); }
    return reply('ok');
  } catch (error) {
    return reply('error');
  }
}

/** The request as a whole; each line is checked on its own in write(). */
function recordProblem(record) {
  if (!record || record.format !== FORMAT || record.version !== 1) return 'format';
  if (!Array.isArray(record.prescriptions) || !Array.isArray(record.failed)) return 'items';
  if (record.prescriptions.length > MAX_PRESCRIPTIONS || record.failed.length > MAX_FAILED) return 'items';
  if (!record.prescriptions.length && !record.failed.length) return 'empty';
  return '';
}

/**
 * Why a line is not a de-identified sample, '' when it is one: the collector's layout (14 fields, then 5 per drug, a ; at the
 * end), field 4 (name) and 9 blank, field 5 only SEXM or SEXF, field 6 only an age band or a birth date's shape, the fields kept
 * as scanned in plain ASCII. Field numbers count from 1, as in the README.
 */
function lineProblem(line) {
  if (typeof line !== 'string' || !line || line.length > MAX_LINE) return '長度不符';
  if (/[\r\n\u2028\u2029]/.test(line)) return '含換行';
  if (!line.endsWith(';')) return '結尾不是分號';
  const f = line.slice(0, -1).split(';');
  if (f.length < 19 || (f.length - 14) % 5 !== 0) return '欄位數 ' + f.length;
  if (f[3] !== '') return '第 4 欄（姓名）不是空白';
  if (f[8] !== '') return '第 9 欄不是空白';
  if (['', 'SEXM', 'SEXF'].indexOf(f[4]) < 0) return '第 5 欄不是性別標記';
  // A band, or an unreadable birth date's shape: its digits 9, letters A, other characters X, symbols as they were.
  if (f[5] !== '' && !/^AGE(?:\d?0-\d?9|60-64|65-69|90\+|\?[9AX\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]{1,12}|\?len\d{2,5})$/.test(f[5])) return '第 6 欄不是年齡層';
  for (const n of [1, 2, 8, 10, 12]) if (!/^[\x20-\x7E]*$/.test(f[n - 1])) return '第 ' + n + ' 欄不是半形英數';
  if (!/^[0-9A-Za-z]{1,20}$/.test(f[0])) return '第 1 欄不是醫事機構代碼';
  for (const n of [3, 7, 11]) if (!/^[0-9A-Za-z]{0,4}$/.test(f[n - 1])) return '第 ' + n + ' 欄超過 4 碼英數';
  if (f[12] !== '' && f[12] !== f[0]) return '第 13 欄與第 1 欄不同';
  if (f[13] !== '' && !f[13].split(',').every(part => /^\s*過敏史[:：]/.test(part))) return '第 14 欄不是過敏史';
  for (let i = 14; i < f.length; i += 5) if (!f[i].trim()) return '藥品健保碼空白';
  if (f.some(value => value.length > 200)) return '欄位過長';
  return '';
}
/** The 健保碼 the page's 六碼 lookup had no 六碼 for: only codes that are on the line itself are kept. */
function unmappedOf(value, f) {
  if (!Array.isArray(value)) return [];
  const codes = {};
  for (let i = 14; i < f.length; i += 5) codes[f[i]] = true;
  return value.filter((code, i) => typeof code === 'string' && codes[code] === true && value.indexOf(code) === i);
}
/** What checking the same patient's prescriptions together added: caution numbers with their level, or 同成分重複, nothing else. */
const mergedOf = value => Array.isArray(value) ? value.filter((key, i) => typeof key === 'string' && /^(?:[0-9A-Za-z]{1,8}|同成分重複)[紅黃灰]$/.test(key) && value.indexOf(key) === i) : [];
/** A failure line names a reason and a field count, nothing scanned. */
const failureProblem = text => typeof text === 'string' && /^失敗：[^;\r\n\u2028\u2029]{1,160}，欄位數 \d{1,5}$/.test(text) ? '' : '失敗行格式不符';

/** Appends the request's lines to 樣本 and its failures to 失敗; returns where the lines went, for selfTest(). */
function write(record) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const received = stamp(new Date()); const batch = Utilities.getUuid().slice(0, 8);
  const app = cell(record.app); const sent = cell(record.sent); const rules = cell(record.rules);
  const rows = []; const failures = [];
  for (const item of record.prescriptions) {
    const line = item && item.line;
    const problem = lineProblem(line);
    if (problem) { failures.push([received, app, batch, '伺服器拒收：' + problem, '']); continue; }
    const f = line.slice(0, -1).split(';');
    // A line sent without a check (the page could not load the rules) has no rules version either.
    const check = item.check && typeof item.check === 'object' ? item.check : undefined;
    const qrs = Number.isInteger(item.qrs) && item.qrs >= 1 && item.qrs <= 9 ? String(item.qrs) : '1';
    const c = check || {};
    rows.push([received, sent, app, check ? rules : '', batch, qrs, f[0], cell(f[6]), cell(f[5]), f[4], cell(f[11]), String((f.length - 14) / 5),
      ['紅', '黃', '灰'].indexOf(c.top) >= 0 ? c.top : '', list(c.alerts), list(c.cautions), list(c.unexplained),
      list(c.unknownDrugs), list(c.unknownDx), cell(line, MAX_LINE), digest(line), '', '', list(unmappedOf(item.unmapped, f)), list(mergedOf(item.merged))]);
  }
  for (const text of record.failed) {
    const problem = failureProblem(text);
    failures.push([received, app, batch, problem ? '伺服器拒收：' + problem : cell(text), '']);
  }
  const at = append(sheet(book, '樣本', SAMPLES), rows);
  append(sheet(book, '失敗', FAILURES), failures);
  return { row: at, count: rows.length };
}

/** Every new row, then marks them: the earlier row a line repeats, and the export it went into. */
function weekly() {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { return summarize(); } finally { lock.releaseLock(); }
}
function summarize() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const samples = sheet(book, '樣本', SAMPLES); const failuresSheet = sheet(book, '失敗', FAILURES);
  const values = samples.getDataRange().getValues().slice(1).map(row => row.map(String));
  const failureValues = failuresSheet.getDataRange().getValues().slice(1).map(row => row.map(String));
  const col = name => SAMPLES.indexOf(name);
  const seen = {}; const known = {};
  const fresh = [];
  values.forEach((row, i) => {
    if (row[col('匯出檔')]) { if (!seen[row[col('內容摘要')]]) seen[row[col('內容摘要')]] = i + 2; known[row[col('醫事機構代碼')]] = true; return; }
    const repeat = seen[row[col('內容摘要')]];
    if (!repeat) seen[row[col('內容摘要')]] = i + 2;
    fresh.push({ index: i, repeat: repeat || '', row: sampleOfRow(row) });
  });
  const failures = failureValues.map((row, i) => ({ index: i, text: row[3], done: row[4] })).filter(item => !item.done);
  const now = stamp(new Date());
  if (!fresh.length && !failures.length) {
    sheet(book, '每週統計', WEEKS).appendRow([now, '', '', 0, 0, 0, 0, 0, 0, 0, '', '', '', '']);
    return 'nothing new';
  }
  // From the first new row to today: the summary covers everything since the last one.
  const from = fresh.map(item => item.row.received.slice(0, 10)).concat(failures.map(item => failureValues[item.index][0].slice(0, 10))).sort()[0];
  const to = now.slice(0, 10);
  const unique = fresh.filter(item => !item.repeat);
  let exported = '';
  if (unique.length) {
    exported = `處方QR去識別化_自動_${from.replace(/-/g, '')}-${to.replace(/-/g, '')}_${unique.length}張.txt`;
    folder(VALIDATION_FOLDER).createFile(exported, unique.map(item => item.row.line + '\n').join(''), MimeType.PLAIN_TEXT);
  }
  const summary = report({ from, to, made: now, exported, samples: fresh.map(item => Object.assign({ repeat: item.repeat }, item.row)),
    failures: failures.map(item => item.text), known });
  const title = `週檢查資料_${to.replace(/-/g, '')}`;
  const doc = DocumentApp.create(title);
  doc.getBody().setText(summary.text);
  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  file.moveTo(folder(REVIEW_FOLDER));

  // Mark the rows: the two columns are rewritten whole, so earlier marks stay as they were.
  const marks = values.map(row => [row[col('重複於')], row[col('匯出檔')]]);
  for (const item of fresh) marks[item.index] = [String(item.repeat), exported || title];
  if (marks.length) samples.getRange(2, col('重複於') + 1, marks.length, 2).setNumberFormat('@').setValues(marks);
  for (const item of failures) failuresSheet.getRange(item.index + 2, 5).setValue(title);
  const s = summary.stats;
  sheet(book, '每週統計', WEEKS).appendRow([now, from, to, fresh.length, fresh.length - unique.length, failures.length, s.institutions, s.newInstitutions,
    s.red, s.yellow, s.rate, s.rules, exported, file.getUrl()]);
  return title;
}
/** A 樣本 row back as the fields the summary reads. */
function sampleOfRow(row) {
  const get = name => row[SAMPLES.indexOf(name)] || '';
  const split = name => get(name) ? get(name).split(SEP) : [];
  return { received: get('收到時間'), app: get('程式版本'), batch: get('批次'), rules: get('規則版本'), qrs: Number(get('QR數')) || 1, institution: get('醫事機構代碼'), dept: get('科別'), age: get('年齡層'),
    sex: get('性別'), dx: get('診斷碼'), top: get('最高等級'), checked: !!get('規則版本'), alerts: split('警示'), cautions: split('注意事項'),
    unexplained: split('未解釋'), unknownDrugs: split('查無藥品'), unknownDx: split('查無診斷'), unmapped: split('對照檔查無'), merged: split('合併多出'),
    line: get('去識別化內容') };
}

/**
 * The weekly summary as text, from the new rows (repeat: the row an earlier copy of the line is on) and failures; known: the
 * institutions seen in earlier weeks. Everything but the counts at the top is taken from the lines that are not repeats.
 */
function report(input) {
  const rows = input.samples.filter(row => !row.repeat);
  const count = (map, key, n) => { map[key] = (map[key] || 0) + (n || 1); };
  const ranked = map => Object.keys(map).map(key => [key, map[key]]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const tally = map => ranked(map).map(([key, n]) => `${key} ×${n}`).join('、');
  const out = [];
  const institutions = {}, multi = {}, levels = { 紅: 0, 黃: 0, 灰: 0, '': 0 }, rules = {}, cautions = {}, unknownDrugs = {}, unknownDx = {}, depts = {}, reasons = {};
  const unmapped = {}, unmappedOther = {}, merged = {};
  let combined = 0;
  const atcs = {};
  let unchecked = 0;
  for (const row of rows) {
    count(institutions, row.institution);
    if (row.qrs > 1) count(multi, row.institution);
    if (!row.checked) unchecked++; else levels[row.top in levels ? row.top : '']++;
    count(rules, row.rules || UNCHECKED);
    row.cautions.forEach(id => count(cautions, id));
    row.unknownDrugs.forEach(code => count(unknownDrugs, code));
    row.unknownDx.forEach(code => count(unknownDx, code));
    // A code the NHI drug list does not know either cannot be mapped by its 健保碼: a hospital's own code, a 特材, or an old list.
    row.unmapped.forEach(code => count(row.unknownDrugs.indexOf(code) >= 0 ? unmappedOther : unmapped, code));
    if (row.merged.length) combined++;
    row.merged.forEach(key => count(merged, key));
    const dept = row.dept.trim().toUpperCase();
    if (dept && !(dept.length === 2 || (dept.length === 4 && dept.endsWith('00')))) count(depts, `${dept}（院所 ${row.institution}）`);
    const dx3 = {};
    row.dx.split('#').map(code => code.replace(/\./g, '').trim().toUpperCase().slice(0, 3)).filter(Boolean).forEach(code => { dx3[code] = true; });
    for (const item of row.unexplained) {
      const atc = item.split(' ')[1] || '?';
      const entry = atcs[atc] || (atcs[atc] = { n: 0, institutions: {}, dx: {}, depts: {}, examples: [] });
      entry.n++; entry.institutions[row.institution] = true;
      Object.keys(dx3).forEach(code => count(entry.dx, code));
      count(entry.depts, dept || '（無）');
      if (entry.examples.length < LIMITS.examples) entry.examples.push(row.line);
    }
  }
  for (const text of input.failures) count(reasons, text.replace(/^失敗：/, ''));
  const total = rows.length; const flagged = rows.filter(row => row.top === '紅' || row.top === '黃');
  const newInstitutions = Object.keys(institutions).filter(code => !input.known[code]);
  const rate = total - unchecked ? `${(100 * (levels.紅 + levels.黃) / (total - unchecked)).toFixed(1)}%` : '';

  out.push('GTsloth 處方樣本 週檢查資料', `期間：${input.from} ～ ${input.to}（上次整理後收到的全部資料）`, `整理時間：${input.made}`, '');
  out.push('## 總覽');
  out.push(`收到 ${input.samples.length} 張，重複 ${input.samples.length - total} 張（同一張處方再次領藥或重印），不重複 ${total} 張；失敗 ${input.failures.length} 行。`);
  out.push(`院所 ${Object.keys(institutions).length} 家，其中先前沒出現過的 ${newInstitutions.length} 家。`);
  out.push(`最高等級：紅 ${levels.紅} 張、黃 ${levels.黃} 張（黃紅比例 ${rate || '無'}）、灰 ${levels.灰} 張、無提示 ${levels['']} 張；沒有判定摘要（規則資料未載入）${unchecked} 張。`);
  out.push(`規則版本：${tally(rules) || '無'}`);
  out.push(`有第 2 個 QR 的處方：${rows.filter(row => row.qrs > 1).length} 張`);
  out.push(`匯出檔：${input.exported ? `${VALIDATION_FOLDER}／${input.exported}` : '無（沒有不重複的處方）'}`, '');

  out.push(`## 紅／黃處方（${flagged.length} 張${flagged.length > LIMITS.flagged ? `，只列前 ${LIMITS.flagged} 張` : ''}）`);
  flagged.slice(0, LIMITS.flagged).forEach((row, i) => {
    out.push(`${i + 1}. [${row.top}] 院所 ${row.institution}・科別 ${row.dept || '（空白）'}・${row.age || '年齡不明'}・${row.sex || '性別不明'}・診斷 ${row.dx || '（無）'}`);
    row.alerts.forEach(alert => out.push(`   - ${alert}`));
    out.push(`   行：${row.line}`);
  });
  if (!flagged.length) out.push('（無）');
  out.push('');

  const atcList = ranked(Object.keys(atcs).reduce((map, atc) => { map[atc] = atcs[atc].n; return map; }, {}));
  out.push(`## 未解釋的藥（有診斷，但診斷、同處方、科別都解釋不了；依 ATC，${atcList.length} 種${atcList.length > LIMITS.atcs ? `，只列前 ${LIMITS.atcs} 種` : ''}）`);
  atcList.slice(0, LIMITS.atcs).forEach(([atc, n]) => {
    const entry = atcs[atc];
    out.push(`- ${atc}：${n} 次、${Object.keys(entry.institutions).length} 家院所；同時出現的診斷（前 3 碼）：${ranked(entry.dx).slice(0, 8).map(([code, k]) => `${code} ×${k}`).join('、') || '無'}；科別：${tally(entry.depts)}`);
    entry.examples.forEach(line => out.push(`  範例：${line}`));
  });
  if (!atcList.length) out.push('（無）');
  out.push('');

  const section = (title, map) => {
    const items = ranked(map);
    out.push(`## ${title}`);
    items.slice(0, LIMITS.codes).forEach(([key, n]) => out.push(`- ${key} ×${n}`));
    if (items.length > LIMITS.codes) out.push(`（另有 ${items.length - LIMITS.codes} 項）`);
    if (!items.length) out.push('（無）');
    out.push('');
  };
  section('注意事項命中（編號＋等級）', cautions);
  section('查無藥品碼（不在健保用藥品項，可能是特材或品項表過舊）', unknownDrugs);
  section(`同一病人合併比對多出的注意事項（${combined} 張處方；編號＋等級，同成分重複是和同一病人另一張處方重複；看不出是和哪幾張合併）`, merged);
  // One patient's prescriptions from 批次蒐集, every row of the request (a repeat too: it is still that patient's), to read together.
  const patients = {};
  input.samples.filter(row => String(row.app).endsWith(SAME_PATIENT) && row.batch).forEach(row => { (patients[row.batch] = patients[row.batch] || []).push(row); });
  const groups = Object.keys(patients).map(key => patients[key]).filter(group => group.length > 1);
  out.push(`## 同一病人的多張處方（批次蒐集匯入，同一批次是同一病人；${groups.length} 位病人${groups.length > LIMITS.patients ? `，只列前 ${LIMITS.patients} 位` : ''}）`);
  groups.slice(0, LIMITS.patients).forEach((group, i) => {
    out.push(`${i + 1}. 批次 ${group[0].batch}・${group.length} 張・${group[0].age || '年齡不明'}・${group[0].sex || '性別不明'}`);
    group.forEach(row => {
      out.push(`   - [${row.top || (row.checked ? '無' : '未判定')}] 院所 ${row.institution}・科別 ${row.dept || '（空白）'}・診斷 ${row.dx || '（無）'}${row.merged.length ? `・合併多出 ${row.merged.join('、')}` : ''}${row.repeat ? `・與第 ${row.repeat} 列重複` : ''}`);
      out.push(`     行：${row.line}`);
    });
  });
  if (!groups.length) out.push('（無）');
  out.push('');
  section('對照檔查無此健保碼：健保品項查得到，六碼對照檔沒有（請補 sku-nhi-map.csv）', unmapped);
  section('對照檔查無此健保碼：健保品項也查無（院所自訂碼、特材或品項表過舊；對照檔補不了）', unmappedOther);
  section('查無或舊的診斷碼（查無：表中沒有；類別：只查到前幾碼；舊碼：2014 版已刪除）', unknownDx);
  section('院內科別代碼（不是健保 2 碼，判定時當作科別未知）', depts);
  section('新院所（先前沒出現過的醫事機構代碼，張數）', newInstitutions.reduce((map, code) => { map[code] = institutions[code]; return map; }, {}));
  section('失敗原因（含欄位數）', reasons);
  section('有第 2 個 QR 的院所（張數）', multi);

  return { text: out.join('\n'), stats: { institutions: Object.keys(institutions).length, newInstitutions: newInstitutions.length, red: levels.紅, yellow: levels.黃, rate,
    rules: Object.keys(rules).filter(version => version !== UNCHECKED).join(' ') } };
}

/** Run once from the editor: the sheets, the two folders, and the Monday trigger for weekly(). Running it again replaces the trigger. */
function setup() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const first = book.getSheets()[0];
  if (book.getSheets().length === 1 && first.getName() !== '樣本' && first.getLastRow() === 0) first.setName('樣本');
  sheet(book, '樣本', SAMPLES); sheet(book, '失敗', FAILURES); sheet(book, '每週統計', WEEKS);
  folder(VALIDATION_FOLDER); folder(REVIEW_FOLDER);
  for (const trigger of ScriptApp.getProjectTriggers()) if (trigger.getHandlerFunction() === 'weekly') ScriptApp.deleteTrigger(trigger);
  ScriptApp.newTrigger('weekly').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
}
/** Run from the editor after setup(): writes one synthetic line, reads it back, removes it. */
function selfTest() {
  const line = '0000000000;2;;;SEXF;AGE40-49;AB;1151101;;28;;E119#;0000000000;;TESTCODE01;1;BID;PO;56;';
  const problem = lineProblem(line);
  if (problem) throw new Error('lineProblem: ' + problem);
  const at = write({ format: FORMAT, version: 1, app: 'selfTest', sent: new Date().toISOString(), rules: '', prescriptions: [{ line, qrs: 1 }], failed: [] });
  const samples = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('樣本');
  const back = samples.getRange(at.row, SAMPLES.indexOf('去識別化內容') + 1).getValue();
  const code = samples.getRange(at.row, SAMPLES.indexOf('醫事機構代碼') + 1).getValue();
  samples.deleteRows(at.row, at.count);
  if (back !== line || code !== '0000000000') throw new Error('寫入後讀回不同：' + back + ' / ' + code);
  Logger.log('selfTest ok');
}

function sheet(book, name, header) {
  let target = book.getSheetByName(name);
  if (!target) target = book.insertSheet(name);
  if (target.getLastRow() === 0) { target.getRange(1, 1, 1, header.length).setValues([header]); target.setFrozenRows(1); return target; }
  // Columns added at the end since the sheet was made get their names; the rows before them stay blank there.
  const names = target.getRange(1, 1, 1, header.length).getValues()[0].map(String);
  const from = names.findIndex((name, i) => name !== header[i]);
  if (from >= 0 && names.slice(from).every(name => name === '')) target.getRange(1, from + 1, 1, header.length - from).setValues([header.slice(from)]);
  return target;
}
/** Rows go in as plain text, so codes keep their leading zeros and nothing is read as a number, date or formula. Returns the first row. */
function append(target, rows) {
  const at = target.getLastRow() + 1;
  if (rows.length) target.getRange(at, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
  return at;
}
function folder(name) {
  const parent = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents().next();
  const found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}
/** Text from the page is data: cut to a sane length, and never let it start a formula. */
function cell(value, max) {
  if (value === undefined || value === null) return '';
  const text = String(value).slice(0, max || 500);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}
const list = value => Array.isArray(value) ? cell(value.filter(item => typeof item === 'string').map(item => item.replace(/\s*\|\s*/g, '／')).join(SEP), 2000) : '';
const stamp = date => Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
const digest = text => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8).map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
const reply = text => ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
