import { ask, noul } from "pi-typesafe";
import type { Judge } from "pi-typesafe";

export const DEFAULT_TIMEOUT_MS = 8_000;

export interface ConcisionScores {
  needsRevision: number;
  repetition: number;
  filler: number;
  overExplanation: number;
}

export interface ConcisionThresholds {
  needsRevision: number;
  repetition: number;
  filler: number;
  overExplanation: number;
}

export const DEFAULT_THRESHOLDS: ConcisionThresholds = {
  needsRevision: 0.60,
  repetition: 0.65,
  filler: 0.60,
  overExplanation: 0.70,
};

/** Backward-compatible alias for the main compressibility threshold. */
export const DEFAULT_THRESHOLD = DEFAULT_THRESHOLDS.needsRevision;

export type ConcisionSignal = keyof ConcisionScores;

export interface ThresholdHit {
  signal: ConcisionSignal;
  score: number;
  threshold: number;
}

export interface ConcisionPass {
  ok: true;
  pass: boolean;
  scores: ConcisionScores;
  hits: ThresholdHit[];
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
  /** Backward-compatible shorthand for thresholds.needsRevision. */
  threshold?: number;
  thresholds?: Partial<ConcisionThresholds>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function validProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function normalizeThreshold(value: number | undefined, fallback = DEFAULT_THRESHOLD): number {
  return value !== undefined && validProbability(value) ? value : fallback;
}

export function normalizeThresholds(
  thresholds: Partial<ConcisionThresholds> = {},
  mainThreshold?: number,
): ConcisionThresholds {
  return {
    needsRevision: normalizeThreshold(
      mainThreshold ?? thresholds.needsRevision,
      DEFAULT_THRESHOLDS.needsRevision,
    ),
    repetition: normalizeThreshold(thresholds.repetition, DEFAULT_THRESHOLDS.repetition),
    filler: normalizeThreshold(thresholds.filler, DEFAULT_THRESHOLDS.filler),
    overExplanation: normalizeThreshold(thresholds.overExplanation, DEFAULT_THRESHOLDS.overExplanation),
  };
}

export function thresholdHits(
  scores: ConcisionScores,
  thresholds: ConcisionThresholds,
): ThresholdHit[] {
  const signals: ConcisionSignal[] = ["needsRevision", "repetition", "filler", "overExplanation"];
  return signals.flatMap(signal =>
    scores[signal] >= thresholds[signal]
      ? [{ signal, score: scores[signal], threshold: thresholds[signal] }]
      : [],
  );
}

export async function evaluateConcision(
  judge: Judge,
  request: string,
  response: string,
  options: EvaluateConcisionOptions = {},
): Promise<ConcisionVerdict> {
  const thresholds = normalizeThresholds(options.thresholds, options.threshold);
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
  const hits = thresholdHits(scores, thresholds);

  return {
    ok: true,
    pass: hits.length === 0,
    scores,
    hits,
    model: result.model,
    elapsedMs: result.elapsedMs,
  };
}

export function formatScore(value: number): string {
  return value.toFixed(2);
}

export function signalLabel(signal: ConcisionSignal): string {
  switch (signal) {
    case "needsRevision": return "revise";
    case "repetition": return "repetition";
    case "filler": return "filler";
    case "overExplanation": return "over-explanation";
  }
}

export function revisionFeedback(
  scores: ConcisionScores,
  thresholds: ConcisionThresholds = DEFAULT_THRESHOLDS,
): string {
  const hits = thresholdHits(scores, thresholds);
  const issues = hits.length
    ? hits.map(hit => `${signalLabel(hit.signal)} ${formatScore(hit.score)} >= ${formatScore(hit.threshold)}`)
    : [`compressibility ${formatScore(scores.needsRevision)}`];

  return [
    "pi-jev-concise: revise your immediately previous answer.",
    `Jev found one or more concision signals above the configured threshold: ${issues.join(", ")}.`,
    "Rewrite the previous answer only. Preserve all information needed to satisfy the user's request, including necessary precision, caveats, and actionable details, but remove repetition, filler, unnecessary framing, and over-explanation.",
    "Do not redo the underlying task, do not call tools unless the previous answer cannot be revised without them, and do not mention this quality check. Return only the revised answer.",
  ].join("\n");
}
