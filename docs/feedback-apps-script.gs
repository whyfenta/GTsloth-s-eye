/**
 * 樹懶的管理 · 校對回饋接收端（Google Apps Script，綁定在回饋試算表上）。
 * 網頁在產生 PDF 時 POST 一份 gtsloth-management-review JSON；這裡驗證後寫入兩個工作表：
 *   「送出紀錄」每次送出一列（時間、版本、門市編號、策略與筆數摘要）
 *   「明細」每筆名稱修正／欄位修改／未修改即確認／手動排除各一列，方便篩選與定期查閱
 * 設定步驟見 README「校對回饋」。
 */
const FORMAT = 'gtsloth-management-review';
const MAX_BYTES = 200000;
const MAX_ITEMS = 1000;
const SUBMISSIONS = ['收到時間', '送出時間', '程式版本', '門市編號', '策略', '合作診所', '遮罩', '庫存列', '調劑列', '提示列', '修改列', '未修改即確認', '手動排除', '自動排除', '送出編號'];
const DETAILS = ['收到時間', '送出編號', '門市編號', '程式版本', '類型', '報表', '六碼', '原始品名', '欄位', '修改前／自動清理', '修改後／人工修正', '程式提示', '排除理由'];
const TYPE = { names: '名稱修正', edits: '欄位修改', confirmedAsIs: '未修改即確認', exclusions: '手動排除' };
const REPORT = { usage: '調劑表', inventory: '庫存簡表' };
const STRATEGY = { hamster: '倉鼠派', balanced: '平衡派', antelope: '羚羊派' };

function doPost(e) {
  try {
    const text = e && e.postData && e.postData.contents || '';
    if (!text || text.length > MAX_BYTES) return reply('rejected: size');
    const record = JSON.parse(text);
    if (!record || record.format !== FORMAT || record.version !== 2) return reply('rejected: format');
    const lists = ['names', 'edits', 'confirmedAsIs', 'exclusions'];
    if (lists.some(key => !Array.isArray(record[key])) || lists.reduce((n, key) => n + record[key].length, 0) > MAX_ITEMS) return reply('rejected: items');
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try { write(record); } finally { lock.releaseLock(); }
    return reply('ok');
  } catch (error) {
    return reply('error');
  }
}

function write(record) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const received = new Date(); const id = Utilities.getUuid().slice(0, 8);
  const store = Number.isInteger(record.store) ? record.store : '';
  const s = record.summary || {}; const o = record.options || {};
  sheet(book, '送出紀錄', SUBMISSIONS).appendRow([received, cell(record.sent), cell(record.app), store, STRATEGY[o.safetyStrategy] || cell(o.safetyStrategy), o.partnerClinic ? '是' : '否', o.partnerCover === 'wide' ? '0.2 個月' : '0.1 個月',
    num(s.stockRows), num(s.usageRows), num(s.flagged), num(s.edited), num(s.confirmedAsIs), num(s.userExcluded), num(s.autoExcluded), id]);
  const rows = [];
  const base = (type, item) => [received, id, store, cell(record.app), TYPE[type], REPORT[item.report] || (type === 'names' ? REPORT.inventory : ''), cell(item.sku), cell(item.rawName)];
  for (const item of record.names) rows.push([...base('names', item), 'name', cell(item.cleaned), cell(item.corrected), notes(item.notes), '']);
  for (const item of record.edits) rows.push([...base('edits', item), cell(item.field), cell(item.before), cell(item.after), '', '']);
  for (const item of record.confirmedAsIs) rows.push([...base('confirmedAsIs', item), '', cell(item.name), '', notes(item.notes), '']);
  for (const item of record.exclusions) rows.push([...base('exclusions', item), '', '', '', '', cell(item.reason)]);
  if (rows.length) { const details = sheet(book, '明細', DETAILS); details.getRange(details.getLastRow() + 1, 1, rows.length, DETAILS.length).setValues(rows); }
}

function sheet(book, name, header) {
  let target = book.getSheetByName(name);
  if (!target) { target = book.insertSheet(name); target.appendRow(header); target.setFrozenRows(1); }
  return target;
}
/** Text from the page is data: cut to a sane length, and never let it start a formula. */
function cell(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).slice(0, 500);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}
const num = value => Number.isFinite(value) ? value : '';
const notes = list => Array.isArray(list) ? cell(list.join('；')) : '';
const reply = text => ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
