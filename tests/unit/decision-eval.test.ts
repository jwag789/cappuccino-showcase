import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATE,
  emptyTally,
  gateFailures,
  isDecoy,
  scoreCase,
  scorecard,
  type DecisionCase,
  type DecisionDataset,
} from "@/evals/decisions/score";
import type { ExtractedDecision } from "@/lib/extraction";

/**
 * The decisions eval's arithmetic.
 *
 * Tested because the gate is a number this code computes, and a gate that
 * computes the wrong number is worse than no gate: it waves through a prompt
 * that fills the register with proposals, or blocks a good one, and either way
 * nobody looks a second time. The eval itself calls a model and cannot run
 * here; this is the half that can.
 */

function decision(over: Partial<ExtractedDecision> = {}): ExtractedDecision {
  return {
    statement: "Settlement runs in 4-hour batches.",
    owner: null,
    decided_at: null,
    confidence: 0.9,
    excerpt: "settlement runs in 4-hour batches",
    supersedes_hint: null,
    ...over,
  };
}

function testCase(over: Partial<DecisionCase> = {}): DecisionCase {
  return {
    id: "case",
    team: "Payments",
    text: "...",
    expect: [{ statementContains: "4-hour batches" }],
    decoys: [],
    ...over,
  };
}

describe("scoring a case", () => {
  it("counts a planted decision that was found", () => {
    const tally = emptyTally();
    scoreCase(tally, testCase(), [decision()]);
    expect(tally).toMatchObject({ found: 1, missed: 0, spurious: 0 });
  });

  it("counts a planted decision that was missed", () => {
    const tally = emptyTally();
    scoreCase(tally, testCase(), []);
    expect(tally).toMatchObject({ found: 0, missed: 1, spurious: 0 });
  });

  it("counts an extraction that matched nothing planted", () => {
    const tally = emptyTally();
    scoreCase(tally, testCase({ expect: [] }), [decision()]);
    expect(tally).toMatchObject({ found: 0, spurious: 1, decoysHit: 0 });
  });

  it("separates a decoy from an ordinary invention", () => {
    // Both are precision failures, but a decoy says the prompt cannot tell a
    // proposal from a decision, which is a different fix from a hallucination.
    const tally = emptyTally();
    scoreCase(
      tally,
      testCase({ expect: [], decoys: ["might work"] }),
      [decision({ statement: "Ship Thursday.", excerpt: "Thursday might work" })]
    );
    expect(tally).toMatchObject({ spurious: 1, decoysHit: 1 });
  });

  it("matches one planted decision at most once", () => {
    // Two extractions of the same decision are one hit and one spurious, not
    // two hits — otherwise a model that repeats itself scores above 100% recall.
    const tally = emptyTally();
    scoreCase(tally, testCase(), [decision(), decision()]);
    expect(tally).toMatchObject({ found: 1, spurious: 1 });
  });
});

describe("decoy detection", () => {
  it("catches a decoy through the excerpt when the statement was paraphrased", () => {
    // The excerpt is the one that matters: the model rewrites the statement,
    // so a wrongly-extracted proposal often reads nothing like the decoy.
    const extracted = decision({
      statement: "The team will ship on Thursday.",
      excerpt: "Thursday might work for the launch",
    });
    expect(isDecoy(extracted, ["Thursday might work"])).toBe("Thursday might work");
  });

  it("does not flag a real decision as a decoy", () => {
    expect(isDecoy(decision(), ["might work", "I think we should"])).toBeNull();
  });
});

describe("field accuracy", () => {
  it("scores an owner the extraction got right", () => {
    const tally = emptyTally();
    scoreCase(tally, testCase({ expect: [{ statementContains: "4-hour", owner: "dana" }] }), [
      decision({ owner: "Dana Cole" }),
    ]);
    expect(tally.owner).toEqual({ checked: 1, correct: 1 });
  });

  it("scores an owner the extraction invented", () => {
    const tally = emptyTally();
    scoreCase(tally, testCase({ expect: [{ statementContains: "4-hour", owner: "dana" }] }), [
      decision({ owner: "Sam Rivera" }),
    ]);
    expect(tally.owner).toEqual({ checked: 1, correct: 0 });
  });

  it("asserts emptiness when the label is null", () => {
    // The date-about-is-not-date-decided case: the only date in the text is
    // the thing decided, so decided_at must stay empty.
    const want = { statementContains: "4-hour", decidedAt: null };
    const right = emptyTally();
    scoreCase(right, testCase({ expect: [want] }), [decision({ decided_at: null })]);
    expect(right.decidedAt).toEqual({ checked: 1, correct: 1 });

    const wrong = emptyTally();
    scoreCase(wrong, testCase({ expect: [want] }), [decision({ decided_at: "2026-11-12" })]);
    expect(wrong.decidedAt).toEqual({ checked: 1, correct: 0 });
  });

  it("compares dates by calendar day, not by string", () => {
    const tally = emptyTally();
    scoreCase(tally, testCase({ expect: [{ statementContains: "4-hour", decidedAt: "2026-03-14" }] }), [
      decision({ decided_at: "2026-03-14T09:30:00Z" }),
    ]);
    expect(tally.decidedAt).toEqual({ checked: 1, correct: 1 });
  });

  it("only scores a field the case actually labelled", () => {
    const tally = emptyTally();
    scoreCase(tally, testCase(), [decision({ owner: "anyone", decided_at: "2026-01-01" })]);
    expect(tally.owner.checked).toBe(0);
    expect(tally.decidedAt.checked).toBe(0);
  });
});

describe("the scorecard", () => {
  it("computes precision and recall the usual way", () => {
    const tally = emptyTally();
    Object.assign(tally, { found: 6, missed: 2, spurious: 2 });
    const card = scorecard(tally);
    expect(card.precision).toBeCloseTo(6 / 8);
    expect(card.recall).toBeCloseTo(6 / 8);
  });

  it("reports the decoy rate against decoys planted, not extractions made", () => {
    // Otherwise a suite that extracts a lot dilutes its own decoy rate and the
    // ceiling stops meaning anything.
    const tally = emptyTally();
    Object.assign(tally, { found: 20, spurious: 2, decoysHit: 2, decoysPlanted: 10 });
    expect(scorecard(tally).decoyRate).toBeCloseTo(0.2);
  });

  it("scores an empty suite 1 rather than 0", () => {
    // Nothing planted is not a failure to find it. The run guards separately
    // against the model producing nothing, which is the case this would hide.
    const card = scorecard(emptyTally());
    expect(card.precision).toBe(1);
    expect(card.recall).toBe(1);
  });
});

describe("the gate", () => {
  const card = (over: Partial<ReturnType<typeof scorecard>>) => ({
    precision: 1, recall: 1, f1: 1, decoyRate: 0, ownerAccuracy: 1, decidedAtAccuracy: 1, ...over,
  });

  it("passes a clean run", () => {
    expect(gateFailures(card({}))).toEqual([]);
  });

  it("blocks on precision below the floor", () => {
    expect(gateFailures(card({ precision: 0.79 }))).toHaveLength(1);
    expect(gateFailures(card({ precision: GATE.precision }))).toEqual([]);
  });

  it("blocks on a decoy rate above the ceiling", () => {
    expect(gateFailures(card({ decoyRate: 0.16 }))).toHaveLength(1);
    expect(gateFailures(card({ decoyRate: GATE.decoyRate }))).toEqual([]);
  });

  it("reports both when both fail", () => {
    expect(gateFailures(card({ precision: 0.5, decoyRate: 0.5 }))).toHaveLength(2);
  });
});

describe("the corpus", () => {
  const dataset: DecisionDataset = JSON.parse(
    readFileSync(join(process.cwd(), "evals/dataset/decisions.json"), "utf-8")
  );

  it("plants enough decoys for the ceiling to mean something", () => {
    // At the 15% ceiling, a suite with six decoys fails on one mistake and
    // passes on none — a gate with no resolution between them.
    const decoys = dataset.extraction.reduce((n, c) => n + c.decoys.length, 0);
    expect(decoys).toBeGreaterThanOrEqual(10);
  });

  it("includes cases where the right answer is nothing at all", () => {
    // Most text contains no decisions. A corpus without that case rewards a
    // prompt that always finds something.
    expect(dataset.extraction.filter((c) => c.expect.length === 0).length).toBeGreaterThanOrEqual(4);
  });

  it("tests dedup in both directions", () => {
    // Over-merging is the worse failure — it hides a real decision behind an
    // unrelated one — so the corpus has to check that too, not just collapsing.
    expect(dataset.dedup.some((c) => c.expectRows === 1)).toBe(true);
    expect(dataset.dedup.some((c) => c.expectRows > 1)).toBe(true);
  });

  it("gives every case a unique id", () => {
    const ids = dataset.extraction.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
