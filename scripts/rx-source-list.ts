// docs/reference/rx-sources.csv: the guidelines, criteria and regulatory sources the 處方警示 rules rest on, which version each
// rule was written against, and when someone last looked for a newer one. Used by `npm run rx-sources`, the tests, the weekly
// review of samples and the monthly source check (docs/rx-sources-review.md).
export const SOURCE_STATES = ['使用中', '建議加入', '待決定', '僅供查證', '不採用'] as const;
export interface Source {
  id: string; name: string; publisher: string; version: string; versionDate: string; frequency: string;
  /** Months between checks for a newer version; 0 for a source that needs none. */
  cycle: number;
  /** YYYY-MM-DD, or '' when nobody has checked it against the publisher yet. */
  checked: string;
  state: typeof SOURCE_STATES[number]; use: string;
  /** What a rule's 依據 says when it rests on this source: any of these. */
  cites: string[];
  url: string; note: string;
}
const COLUMNS = ['編號', '名稱', '發布單位', '目前版本', '版本日期', '更新頻率', '確認週期月', '上次確認', '狀態', '用途', '引用寫法', '網址', '備註'];

/** The list from its rows (each keyed by the header), or the reasons it cannot be read. */
export function readSources(rows: Record<string, string>[]): { sources: Source[]; problems: string[] } {
  const problems: string[] = [], sources: Source[] = [], ids = new Set<string>();
  if (rows[0] && COLUMNS.some(column => !(column in rows[0]))) problems.push(`表頭要有：${COLUMNS.join('、')}`);
  rows.forEach((row, i) => {
    const at = `第 ${i + 2} 列（${row['編號'] || '沒有編號'}）`;
    const get = (name: string) => (row[name] ?? '').trim();
    if (!/^S\d{2}$/.test(get('編號'))) problems.push(`${at}：編號要寫成 S＋兩位數`);
    if (ids.has(get('編號'))) problems.push(`${at}：編號重複`);
    ids.add(get('編號'));
    if (!get('名稱') || !get('發布單位') || !get('用途')) problems.push(`${at}：名稱、發布單位、用途不可空白`);
    if (!(SOURCE_STATES as readonly string[]).includes(get('狀態'))) problems.push(`${at}：狀態只能是 ${SOURCE_STATES.join('、')}`);
    if (get('確認週期月') && !/^\d{1,2}$/.test(get('確認週期月'))) problems.push(`${at}：確認週期月要是數字（幾個月確認一次）`);
    if (get('上次確認') && (!/^\d{4}-\d\d-\d\d$/.test(get('上次確認')) || Number.isNaN(Date.parse(get('上次確認'))))) problems.push(`${at}：上次確認要寫成 YYYY-MM-DD`);
    if (get('網址') && !/^https:\/\/\S+$/.test(get('網址'))) problems.push(`${at}：網址要以 https:// 開頭`);
    if (get('狀態') === '使用中' && !get('引用寫法')) problems.push(`${at}：使用中的來源要有引用寫法`);
    sources.push({ id: get('編號'), name: get('名稱'), publisher: get('發布單位'), version: get('目前版本'), versionDate: get('版本日期'), frequency: get('更新頻率'),
      cycle: Number(get('確認週期月')) || 0, checked: get('上次確認'), state: get('狀態') as Source['state'], use: get('用途'),
      cites: get('引用寫法').split('|').map(text => text.trim()).filter(Boolean), url: get('網址'), note: get('備註') });
  });
  return { sources, problems };
}

/** A citation that names a version ("Beers 2023") belongs to a family ("Beers"): a rule citing the family with another year is behind. */
const family = (cite: string) => /^(.*\S)\s+(?:\d{4}|v\d+)$/.exec(cite)?.[1];
export interface Citation { sources: string[]; outdated: string[] }
/** Which sources a rule's 依據 rests on, and the versioned ones it names with a version the list does not have. */
export function citation(basis: string, sources: Source[]): Citation {
  const found: string[] = [], outdated: string[] = [];
  for (const source of sources) {
    if (source.cites.some(cite => basis.includes(cite))) { found.push(source.id); continue; }
    if (source.cites.some(cite => { const name = family(cite); return !!name && basis.includes(name); })) outdated.push(source.id);
  }
  return { sources: found, outdated };
}

const monthsBetween = (from: string, to: string) => {
  const a = new Date(`${from}T00:00:00Z`), b = new Date(`${to}T00:00:00Z`);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
};
/** The sources due for a look on a day: never checked, or checked at least their cycle ago. 不採用 and cycle 0 are never due. */
export function dueSources(sources: Source[], today: string): Source[] {
  return sources.filter(source => source.cycle > 0 && source.state !== '不採用' && (!source.checked || monthsBetween(source.checked, today) >= source.cycle));
}
