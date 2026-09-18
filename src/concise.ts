import { ask, noul } from "pi-typesafe";
import type { Judge } from "pi-typesafe";

export const DEFAULT_THRESHOLD = 0.72;
export const DEFAULT_TIMEOUT_MS = 8_000;

export interface ConcisionScores {
  needsRevision: number;
  repetition: number;
  filler: number;
  overExplanation: number;
}

export interface ConcisionPass {
  ok: true;
  pass: boolean;
  scores: ConcisionScores;
  model: string;
  elapsedMs: number;
}

export interface ConcisionFailure {
  ok: false;
  error: string;
  errorCode?: string;
}

export type ConcisionVerdict = ConcisionPass | ConcisionFailure;

export interface EvaluateConcisionOptions {
  threshold?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function validProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function normalizeThreshold(value: number | undefined): number {
  return value !== undefined && validProbability(value) ? value : DEFAULT_THRESHOLD;
}

export async function evaluateConcision(
  judge: Judge,
  request: string,
  response: string,
  options: EvaluateConcisionOptions = {},
): Promise<ConcisionVerdict> {
  const threshold = normalizeThreshold(options.threshold);
  const result = await ask(judge, {
    state: {
      user_request: request,
      assistant_response: response,
    },
    questions: {
      needsRevision: noul(
        "Could the assistant response be made materially shorter while satisfying the user's request equally well, without losing useful information, precision, caveats, or actionable details? Answer yes only when a rewrite would improve signal-to-noise, not merely because a shorter wording exists.",
      ),
      repetition: noul(
        "Does the assistant response repeat the same substantive point, conclusion, warning, or instruction more than needed?",
      ),
      filler: noul(
        "Does the assistant response contain filler, unnecessary preamble, meta-commentary, throat-clearing, or closing text that does not help satisfy the user's request?",
      ),
      overExplanation: noul(
        "Does the assistant response explain straightforward points in substantially more detail than the user's request requires?",
      ),
    },
  }, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    };
  }

  const scores: ConcisionScores = {
    needsRevision: result.answers.needsRevision.noul,
    repetition: result.answers.repetition.noul,
    filler: result.answers.filler.noul,
    overExplanation: result.answers.overExplanation.noul,
  };

  return {
    ok: true,
    pass: scores.needsRevision < threshold,
    scores,
    model: result.model,
    elapsedMs: result.elapsedMs,
  };
}

export function formatScore(value: number): string {
  return value.toFixed(2);
}

export function revisionFeedback(scores: ConcisionScores): string {
  const issues: string[] = [];
  if (scores.repetition >= 0.5) issues.push(`repetition ${formatScore(scores.repetition)}`);
  if (scores.filler >= 0.5) issues.push(`filler ${formatScore(scores.filler)}`);
  if (scores.overExplanation >= 0.5) issues.push(`over-explanation ${formatScore(scores.overExplanation)}`);
  if (!issues.length) issues.push(`compressibility ${formatScore(scores.needsRevision)}`);

  return [
    "pi-jev-concise: revise your immediately previous answer.",
    `Jev judged that it can be materially shorter without reducing its usefulness (P=${formatScore(scores.needsRevision)}).`,
    `Signals: ${issues.join(", ")}.`,
    "Rewrite the previous answer only. Preserve all information needed to satisfy the user's request, including necessary precision, caveats, and actionable details, but remove repetition, filler, unnecessary framing, and over-explanation.",
    "Do not redo the underlying task, do not call tools unless the previous answer cannot be revised without them, and do not mention this quality check. Return only the revised answer.",
  ].join("\n");
}
