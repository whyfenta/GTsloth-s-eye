// Majority vote over several independent readings of one number. A reading
// is accepted without review only when a clear majority agrees on a value
// that also satisfies the field's format; otherwise the candidates are shown.

export type Decision = { value?: string; agreed: boolean; support: number; candidates: string[] };

/** votes: normalised readings (null = unreadable / wrong format). */
export function decide(votes: (string | null)[], minSupport: number): Decision {
  const counts = new Map<string, number>();
  for (const vote of votes) if (vote !== null) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const [value, support] = ranked[0] ?? [undefined, 0];
  // A runner-up with two votes means two readings systematically disagree: ask a person.
  const agreed = support >= minSupport && (ranked[1]?.[1] ?? 0) < 2;
  return { value, agreed, support, candidates: ranked.map(([v]) => v) };
}
