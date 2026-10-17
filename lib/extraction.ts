import { z } from "zod";

/**
 * The shape the extraction pass returns for a settled decision.
 *
 * Only the schema is published here. The extraction pass itself (prompts,
 * chunking and the model call) is part of the private codebase. The eval
 * scorer in `evals/decisions/score.ts` needs the type, and nothing else.
 *
 * Deliberately a much narrower net than a plan. A plan is extracted from
 * anything a team intends, including the hedged and the later-revised — that
 * breadth is what lets detection see drift. A decision is only what was
 * actually settled, because the register is the ground truth detection
 * measures *against*, and a register full of maybes measures nothing.
 */
export const ExtractedDecision = z.object({
  statement: z.string(),
  owner: z.string().nullable(),
  decided_at: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  excerpt: z.string(),
  supersedes_hint: z.string().nullable(),
});

export type ExtractedDecision = z.infer<typeof ExtractedDecision>;
