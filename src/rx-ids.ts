/**
 * Rule numbers (docs/reference/rx-rules.md「編號」). From 115/11/21 a number is its table's letter, a hyphen and digits: C-017
 * (注意事項), I-024 (適應症), D-001 (同處方), K-005 (藥品分類), X-01 (設定), Q-01 (問題), and S- with the department code for 科別常用
 * (S-02, S-AB). The hyphen right after the letter keeps a number from reading as an ATC code (C09), an ICD-10-CM code (I24) or
 * range (I10-I16), a 健保碼 or a proposal (P20261109-01). The digits are the old number's, so an old number (C17, SAB, Q1) turns
 * into its new one by formula wherever it was written down: the team's sheet, samples, notes. Pure functions, used by the review
 * page, the scripts and (as copies) the two Apps Scripts in docs/.
 */
export const RULE_ID = /^(?:[CIDK]-\d{3,}|S-[0-9A-Z]{2}|[XQ]-\d{2,})$/;

/** A number as written now: an old one (C17, I24, S02, SAB, X1, Q1) turned into it; a new one, a proposal or anything else unchanged. */
export function ruleId(id: string): string {
  const numbered = /^([CIDK])(\d+)$/.exec(id);
  if (numbered) return `${numbered[1]}-${numbered[2].padStart(3, '0')}`;
  const department = /^S([0-9A-Z]{2})$/.exec(id);
  if (department) return `S-${department[1]}`;
  const small = /^([XQ])(\d+)$/.exec(id);
  if (small) return `${small[1]}-${small[2].padStart(2, '0')}`;
  return id;
}

/**
 * Names a rule as `ids` write it, whichever form it is given in: C-017 for C17 when `ids` have C-017, C17 for C-017 when they
 * still have C17. A name `ids` do not know stays as it is.
 */
export function asWrittenIn(ids: Iterable<string>): (id: string) => string {
  const written = new Map([...ids].map(id => [ruleId(id), id]));
  return id => written.get(ruleId(id)) ?? id;
}

/** The number as it was written before 115/11/21 (C-017 → C17, C-005 → C05, X-01 → X1, S-AB → SAB), to find it in older notes. */
export function legacyId(id: string): string {
  const numbered = /^([CIDK])-(\d+)$/.exec(id);
  if (numbered) return `${numbered[1]}${String(Number(numbered[2])).padStart(2, '0')}`;
  const department = /^S-([0-9A-Z]{2})$/.exec(id);
  if (department) return `S${department[1]}`;
  const small = /^([XQ])-(\d+)$/.exec(id);
  if (small) return `${small[1]}${Number(small[2])}`;
  return id;
}
