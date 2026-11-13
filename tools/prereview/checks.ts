/** Pure checks on a pre-review verdict: shape, citation numbers and titles, and what a citation fix may change. No network. */
export interface Source { t: string; u: string }
/** Old receipts kept sources as bare addresses. */
export const asSources = (list: unknown[]): Source[] => list.map(s => typeof s === 'string' ? { t: '', u: s } : s as Source);
export const COMPLEXITY = ['只改規則表', '要改判斷程式', '要新的資料來源'] as const;
/** implementation: can it be built with what a prescription QR carries, and at what cost. Written apart; never moves the decision. */
export interface Verdict {
  decision: '同意' | '不同意'; confidence: '高' | '中' | '低'; comment: string; citations: { id: string; title: string }[];
  /** What each page is (t, up to 40 characters) and its address (u): saved as the vote's evidence links, not in the comment. */
  sources: Source[];
  implementation: { complexity: typeof COMPLEXITY[number]; note: string };
}
export function checkShape(verdict: Verdict) {
  if (!['同意', '不同意'].includes(verdict?.decision) || !['高', '中', '低'].includes(verdict.confidence) || typeof verdict.comment !== 'string' || !verdict.comment.trim()
    || !Array.isArray(verdict.sources) || verdict.sources.some(s => typeof s?.t !== 'string' || typeof s?.u !== 'string') || !Array.isArray(verdict.citations) || verdict.citations.some(c => typeof c?.id !== 'string' || typeof c?.title !== 'string')
    || !COMPLEXITY.includes(verdict.implementation?.complexity) || typeof verdict.implementation.note !== 'string' || !verdict.implementation.note.trim())
    throw new Error(`回覆格式不對：${JSON.stringify(verdict).slice(0, 300)}`);
}

/**
 * Every PubMed/PMC number in the comment or the sources must be listed in citations with its title, and each title must match
 * what NCBI holds for that number. One miss fails the whole pre-review: a wrong citation is worse than none.
 */
const norm = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
export function titlesMatch(claimed: string, actual: string): boolean {
  const a = norm(claimed), b = norm(actual);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const words = (s: string) => new Set(s.split(' ').filter(w => w.length > 2));
  const wa = words(a), wb = words(b);
  const shared = [...wa].filter(w => wb.has(w)).length;
  return wa.size > 0 && wb.size > 0 && 2 * shared / (wa.size + wb.size) >= 0.7;
}
export const citationKey = (raw: string): string | undefined => {
  const pmc = /PMC\s*:?\s*(\d{4,9})/i.exec(raw); if (pmc) return `PMC${pmc[1]}`;
  const pmid = /(?:PMID\s*[:：]?\s*|pubmed\.ncbi\.nlm\.nih\.gov\/)(\d{5,9})/i.exec(raw); if (pmid) return `PMID${pmid[1]}`;
  return /^\d{5,9}$/.test(raw.trim()) ? `PMID${raw.trim()}` : undefined;
};

/** One citation against NCBI. missing: mentioned or linked but not listed in citations (claimed is then ''). */
export type Check = { id: string; claimed: string; actual: string; ok: boolean; missing?: boolean };
export const ID_PATTERN = /PMC\s*:?\s*\d{4,9}|PMID\s*[:：]?\s*\d{5,9}|pubmed\.ncbi\.nlm\.nih\.gov\/\d{5,9}/gi;

/** Character-bigram overlap of two texts with every citation number taken out: how much of the wording survived the fix. */
export function sameWording(a: string, b: string): number {
  const strip = (s: string) => s.replace(ID_PATTERN, '').replace(/\s+/g, '');
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(strip(a)), gb = grams(strip(b));
  let shared = 0, total = 0;
  for (const [g, n] of ga) { shared += Math.min(n, gb.get(g) ?? 0); total += n; }
  for (const n of gb.values()) total += n;
  return total ? 2 * shared / total : 1;
}
/**
 * A fix may only replace a wrong number with the right one for the same paper, or drop it. The decision, the confidence, the
 * wording and the citations that were right must stay; a new number must belong to a title the model claimed before.
 */
export function checkFix(before: Verdict, after: Verdict, results: Check[]) {
  const problems: string[] = [];
  if (after.decision !== before.decision || after.confidence !== before.confidence) problems.push('改了決定或信心');
  if (JSON.stringify(after.implementation) !== JSON.stringify(before.implementation)) problems.push('改了實作評估');
  const wording = sameWording(before.comment, after.comment);
  if (wording < 0.9) problems.push(`comment 改動過多（相同 ${(wording * 100).toFixed(0)}%）`);
  const keyed = new Map(after.citations.map(c => [citationKey(c.id) ?? c.id, c.title]));
  for (const r of results.filter(r => r.ok)) if (!keyed.has(r.id) || !titlesMatch(keyed.get(r.id)!, r.claimed)) problems.push(`原本正確的 ${r.id} 被改動`);
  const bad = results.filter(r => !r.ok);
  for (const r of bad.filter(r => !r.missing)) if (keyed.has(r.id)) problems.push(`錯的 ${r.id} 還在`);
  // A number that was linked but not listed may now be listed, with the title NCBI holds for it.
  for (const r of bad.filter(r => r.missing)) if (keyed.has(r.id) && !titlesMatch(keyed.get(r.id)!, r.actual)) problems.push(`補列的 ${r.id} 標題不是 NCBI 上的「${r.actual.slice(0, 60)}」`);
  const earlierIds = new Set(results.map(r => r.id));
  for (const [key, title] of keyed) if (!earlierIds.has(key) && !bad.some(r => !r.missing && titlesMatch(title, r.claimed))) problems.push(`新增的 ${key} 不是原本引用的論文`);
  if (problems.length) throw new Error(`修正不符規則：${problems.join('；')}`);
  return wording;
}
