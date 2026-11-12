/**
 * Proposals from the weekly review of samples (docs/rx-samples-weekly-review.md): what the reviewing Claude suggests, one row
 * each, for the pharmacists to vote on in the review page before anything reaches the rule tables. The weekly review writes them
 * as a sheet in the team's Drive folder (`npm run rx-proposals`), the team's Apps Script hands the rows to the page, and a
 * proposal the team has dealt with is recorded in docs/reference/rx-rules-review.json. Pure functions: no DOM, no network, no files.
 */
/** public/assets/rx/proposals.json: the open proposals as published with the site (`npm run rx-proposals -- --publish`). */
export const PROPOSALS_FORMAT = 'gtsloth-rx-proposals';
export const PROPOSAL_KINDS = ['新增規則', '修改規則', '刪除規則', '新功能', '資料品質', '待決定'] as const;
export type ProposalKind = typeof PROPOSAL_KINDS[number];
export const PROPOSAL_FILES = ['', 'indications', 'co-drugs', 'cautions', 'specialty', 'drug-classes', 'settings'] as const;
/** The sheet's header, in order. 整列內容 is the whole CSV row a rule proposal would add or leave, as the table would hold it. */
export const PROPOSAL_COLUMNS = ['編號', '類型', '標題', '檔案', '整列內容', '證據', '依據等級', '試跑結果', '說明'] as const;
export interface Proposal { id: string; kind: ProposalKind; title: string; file: string; row: string; evidence: string; basis: string; trial: string; note: string }

const LIMITS: Record<keyof Proposal, number> = { id: 12, kind: 8, title: 120, file: 12, row: 1200, evidence: 400, basis: 120, trial: 300, note: 800 };
/** P + the week's date + a two-digit number: P20261109-03. */
export const PROPOSAL_ID = /^P\d{8}-\d{2}$/;
/**
 * What must never reach a shared page: a de-identified sample line (fields separated by ;), an institution code, an age band of
 * one prescription. Evidence is counts and drug–diagnosis pairs. The same patterns guard docs/reference/rx-rules-review.json.
 */
const SAMPLE_CONTENT: [RegExp, string][] = [
  [/(?:[^;\n]*;){8,}/, '像是樣本行（分號分隔的欄位）'],
  [/(?<![0-9A-Za-z])\d{10}(?![0-9A-Za-z])/, '含 10 碼數字（院所代碼）'],
  [/AGE\d|AGE\?|SEX[MF]\b/, '含樣本的年齡層或性別標記'],
];

/** Why a proposal cannot be published, one line each; empty when it can. */
export function proposalProblems(proposal: Partial<Record<keyof Proposal, unknown>>): string[] {
  const problems: string[] = [];
  const text = (key: keyof Proposal) => typeof proposal[key] === 'string' ? (proposal[key] as string) : '';
  for (const key of Object.keys(LIMITS) as (keyof Proposal)[]) {
    if (proposal[key] !== undefined && typeof proposal[key] !== 'string') problems.push(`${key} 不是文字`);
    if (text(key).length > LIMITS[key]) problems.push(`${key} 超過 ${LIMITS[key]} 字`);
    if (/[\r\n\t\u2028\u2029]/.test(text(key))) problems.push(`${key} 含換行或定位字元`);
  }
  if (!PROPOSAL_ID.test(text('id'))) problems.push('編號要寫成 P＋週檢查日期＋兩位數，例如 P20261109-03');
  if (!(PROPOSAL_KINDS as readonly string[]).includes(text('kind'))) problems.push(`類型只能是 ${PROPOSAL_KINDS.join('、')}`);
  if (!text('title').trim()) problems.push('沒有標題');
  if (!(PROPOSAL_FILES as readonly string[]).includes(text('file'))) problems.push(`檔案只能是 ${PROPOSAL_FILES.filter(Boolean).join('、')} 或空白`);
  const ruleChange = ['新增規則', '修改規則', '刪除規則'].includes(text('kind'));
  if (ruleChange && (!text('file') || !text('row').trim())) problems.push('規則的提案要有檔案與整列內容');
  if (!text('evidence').trim()) problems.push('沒有證據（張數、院所數、藥品與診斷的組合）');
  if (!text('basis').trim()) problems.push('沒有依據等級');
  if (ruleChange && !text('trial').trim()) problems.push('規則的提案要有試跑結果');
  for (const key of ['title', 'evidence', 'basis', 'trial', 'note'] as const) {
    for (const [pattern, why] of SAMPLE_CONTENT) if (pattern.test(text(key))) problems.push(`${key} ${why}`);
  }
  // A rule row is commas, not semicolons; a caution's conditions may hold one or two.
  if ((text('row').match(/;/g) ?? []).length > 6) problems.push('row 像是樣本行（分號分隔的欄位）');
  if (/(?<![0-9A-Za-z])\d{10}(?![0-9A-Za-z])/.test(text('row'))) problems.push('row 含 10 碼數字（院所代碼）');
  return problems;
}

/** A cell a spreadsheet would read as a formula, a number or a date is kept as text by a leading apostrophe. */
function cell(value: string): string {
  const safe = /^[=+\-@]/.test(value) || /^[\d.,/\s:-]+$/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
/** The proposals as the CSV the weekly review uploads (it becomes a Google Sheet). Throws on a proposal that cannot be published. */
export function proposalsCsv(proposals: Proposal[]): string {
  const seen = new Set<string>();
  for (const proposal of proposals) {
    const problems = proposalProblems(proposal);
    if (seen.has(proposal.id)) problems.push('編號重複');
    seen.add(proposal.id);
    if (problems.length) throw new Error(`${proposal.id || '（沒有編號）'}：${problems.join('；')}`);
  }
  const rows = proposals.map(p => [p.id, p.kind, p.title, p.file, p.row, p.evidence, p.basis, p.trial, p.note]);
  return [PROPOSAL_COLUMNS as readonly string[], ...rows].map(row => row.map(value => cell(value ?? '')).join(',')).join('\n') + '\n';
}
/** A sheet's rows (header first, as displayed) back as proposals; rows that cannot be published are left out and counted. */
export function proposalsOfRows(rows: unknown): { proposals: Proposal[]; skipped: number } {
  const proposals: Proposal[] = [];
  let skipped = 0;
  if (!Array.isArray(rows)) return { proposals, skipped };
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row) || !row.some(value => String(value ?? '').trim())) continue;
    const [id, kind, title, file, content, evidence, basis, trial, note] = row.map(value => String(value ?? '').replace(/^'/, '').trim());
    const proposal = { id, kind, title, file: file ?? '', row: content ?? '', evidence: evidence ?? '', basis: basis ?? '', trial: trial ?? '', note: note ?? '' } as Proposal;
    if (proposalProblems(proposal).length) skipped++; else proposals.push(proposal);
  }
  return { proposals, skipped };
}
/** The published copy as proposals: only the ones that could be published again, so a damaged file shows nothing rather than anything. */
export function publishedProposals(data: unknown): Proposal[] {
  const file = data as { format?: unknown; proposals?: unknown };
  if (!file || file.format !== PROPOSALS_FORMAT || !Array.isArray(file.proposals)) return [];
  return file.proposals.filter((proposal): proposal is Proposal => !!proposal && typeof proposal === 'object' && !proposalProblems(proposal).length);
}
