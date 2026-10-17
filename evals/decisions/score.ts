import type { ExtractedDecision } from "../../lib/extraction";

/**
 * Scoring for the decisions eval, kept apart from the run so it can be tested
 * without calling a model.
 *
 * That split is not tidiness. The gate — precision below 0.80, decoy rate
 * above 0.15 — is a number this file computes, and a gate that computes the
 * wrong number is worse than no gate: it passes a bad prompt, or blocks a good
 * one, and either way nobody looks again.
 */

export type DecisionExpectation = {
  statementContains: string;
  owner?: string | null;
  /** `null` asserts the field must be empty — the date-about-is-not-date-decided case. */
  decidedAt?: string | null;
};

export type DecisionCase = {
  id: string;
  team: string;
  note?: string;
  text: string;
  expect: DecisionExpectation[];
  /** Spans that must NOT produce a decision. */
  decoys: string[];
};

export type DedupCase = {
  id: string;
  note?: string;
  team: string;
  texts: string[];
  expectRows: number;
};

export type DecisionDataset = { extraction: DecisionCase[]; dedup: DedupCase[] };

const norm = (v: unknown) => String(v ?? "").toLowerCase().trim();

/** Loose containment — the model's wording will never match a label exactly. */
export const mentions = (haystack: unknown, needle: string) => norm(haystack).includes(norm(needle));

export function matchesExpectation(
  decision: ExtractedDecision,
  want: DecisionExpectation
): boolean {
  return mentions(decision.statement, want.statementContains);
}

/**
 * Whether an extracted decision came from a span that was planted as a decoy.
 *
 * Checked against the excerpt as well as the statement, and the excerpt is the
 * one that matters: the model paraphrases when it writes a statement, so a
 * wrongly-extracted proposal often reads nothing like the decoy text — but the
 * excerpt is copied verbatim, so it still contains it.
 */
export function isDecoy(decision: ExtractedDecision, decoys: string[]): string | null {
  for (const decoy of decoys) {
    if (mentions(decision.excerpt, decoy) || mentions(decision.statement, decoy)) return decoy;
  }
  return null;
}

export type FieldTally = { checked: number; correct: number };

export type DecisionTally = {
  /** Planted decisions that were found. */
  found: number;
  /** Planted decisions that were missed. */
  missed: number;
  /** Extracted decisions that matched nothing planted. */
  spurious: number;
  /** Of the spurious, those traceable to a planted decoy. */
  decoysHit: number;
  /** Decoys planted across the suite. */
  decoysPlanted: number;
  owner: FieldTally;
  decidedAt: FieldTally;
  failures: string[];
};

export const emptyTally = (): DecisionTally => ({
  found: 0,
  missed: 0,
  spurious: 0,
  decoysHit: 0,
  decoysPlanted: 0,
  owner: { checked: 0, correct: 0 },
  decidedAt: { checked: 0, correct: 0 },
  failures: [],
});

/** A date matches if it is the same calendar day; null asserts emptiness. */
function dateMatches(got: string | null, want: string | null): boolean {
  if (want === null) return got === null || got.trim() === "";
  if (!got) return false;
  return got.slice(0, 10) === want.slice(0, 10);
}

export function scoreCase(
  tally: DecisionTally,
  testCase: DecisionCase,
  extracted: ExtractedDecision[]
): void {
  tally.decoysPlanted += testCase.decoys.length;

  const unmatched = [...extracted];
  for (const want of testCase.expect) {
    const index = unmatched.findIndex((d) => matchesExpectation(d, want));
    if (index === -1) {
      tally.missed++;
      tally.failures.push(`  ${testCase.id}: missed "${want.statementContains}"`);
      continue;
    }

    const [hit] = unmatched.splice(index, 1);
    tally.found++;

    if (want.owner !== undefined) {
      tally.owner.checked++;
      const ok = want.owner === null ? !hit.owner : mentions(hit.owner, want.owner);
      if (ok) tally.owner.correct++;
      else tally.failures.push(`  ${testCase.id}: owner was "${hit.owner}", wanted "${want.owner}"`);
    }

    if (want.decidedAt !== undefined) {
      tally.decidedAt.checked++;
      if (dateMatches(hit.decided_at, want.decidedAt)) tally.decidedAt.correct++;
      else
        tally.failures.push(
          `  ${testCase.id}: decided_at was "${hit.decided_at}", wanted "${want.decidedAt}"`
        );
    }
  }

  for (const extra of unmatched) {
    tally.spurious++;
    const decoy = isDecoy(extra, testCase.decoys);
    if (decoy) {
      tally.decoysHit++;
      tally.failures.push(`  ${testCase.id}: DECOY extracted — "${extra.statement}" (from "${decoy}")`);
    } else {
      tally.failures.push(`  ${testCase.id}: invented — "${extra.statement}"`);
    }
  }
}

export type Scorecard = {
  precision: number;
  recall: number;
  f1: number;
  decoyRate: number;
  ownerAccuracy: number;
  decidedAtAccuracy: number;
};

export function scorecard(tally: DecisionTally): Scorecard {
  const extracted = tally.found + tally.spurious;
  const planted = tally.found + tally.missed;

  // An empty numerator is scored 1 rather than 0: a suite that planted nothing
  // has not failed at finding it. The run guards separately against the case
  // where the model produced nothing at all, which is the failure this would
  // otherwise hide.
  const precision = extracted === 0 ? 1 : tally.found / extracted;
  const recall = planted === 0 ? 1 : tally.found / planted;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    precision,
    recall,
    f1,
    decoyRate: tally.decoysPlanted === 0 ? 0 : tally.decoysHit / tally.decoysPlanted,
    ownerAccuracy: tally.owner.checked === 0 ? 1 : tally.owner.correct / tally.owner.checked,
    decidedAtAccuracy:
      tally.decidedAt.checked === 0 ? 1 : tally.decidedAt.correct / tally.decidedAt.checked,
  };
}

/** The thresholds the build is gated on. */
export const GATE = { precision: 0.8, decoyRate: 0.15 } as const;

export function gateFailures(card: Scorecard): string[] {
  const failures: string[] = [];
  if (card.precision < GATE.precision) {
    failures.push(
      `precision ${(card.precision * 100).toFixed(1)}% is below the ${GATE.precision * 100}% gate`
    );
  }
  if (card.decoyRate > GATE.decoyRate) {
    failures.push(
      `decoy rate ${(card.decoyRate * 100).toFixed(1)}% is above the ${GATE.decoyRate * 100}% ceiling`
    );
  }
  return failures;
}
