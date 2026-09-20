import { createHash } from "node:crypto";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { createTypeSafe } from "pi-typesafe";
import {
  DEFAULT_THRESHOLDS,
  evaluateConcision,
  formatScore,
  normalizeThreshold,
  revisionFeedback,
  signalLabel,
} from "./concise.js";
import type { ConcisionScores, ConcisionThresholds, ThresholdHit } from "./concise.js";

const PACKAGE_NAME = "pi-jev-concise";
const HIDDEN_ENTRY = `${PACKAGE_NAME}:hidden`;
const APPROVED_ENTRY = `${PACKAGE_NAME}:approved`;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_REQUESTS = 1_000;

interface RuntimeConfig {
  enabled: boolean;
  logs: boolean;
  buffered: boolean;
  thresholds: ConcisionThresholds;
  maxRetries: number;
  maxRequests: number;
}

interface HiddenMarkerData {
  hashes: string[];
}

interface ApprovedAnswerData {
  text: string;
  outcome: "passed" | "fail-open" | "retry-limit";
  timestamp: number;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function loadConfig(): RuntimeConfig {
  return {
    enabled: envBoolean("PI_JEV_CONCISE_ENABLED", true),
    logs: envBoolean("PI_JEV_CONCISE_LOGS", true),
    buffered: envBoolean("PI_JEV_CONCISE_BUFFERED", true),
    thresholds: {
      needsRevision: normalizeThreshold(
        envNumber("PI_JEV_CONCISE_THRESHOLD"),
        DEFAULT_THRESHOLDS.needsRevision,
      ),
      repetition: normalizeThreshold(
        envNumber("PI_JEV_CONCISE_REPETITION_THRESHOLD"),
        DEFAULT_THRESHOLDS.repetition,
      ),
      filler: normalizeThreshold(
        envNumber("PI_JEV_CONCISE_FILLER_THRESHOLD"),
        DEFAULT_THRESHOLDS.filler,
      ),
      overExplanation: normalizeThreshold(
        envNumber("PI_JEV_CONCISE_OVER_EXPLANATION_THRESHOLD"),
        DEFAULT_THRESHOLDS.overExplanation,
      ),
    },
    maxRetries: positiveInteger(envNumber("PI_JEV_CONCISE_MAX_RETRIES"), DEFAULT_MAX_RETRIES),
    maxRequests: positiveInteger(envNumber("PI_JEV_CONCISE_MAX_REQUESTS"), DEFAULT_MAX_REQUESTS),
  };
}

export function contentTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [text] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type !== "text" || typeof candidate.text !== "string") return [];
    const text = candidate.text.trim();
    return text ? [text] : [];
  });
}

function contentText(content: unknown): string {
  return contentTextParts(content).join("\n").trim();
}

export function markdownHash(markdown: string): string {
  return createHash("sha256").update(markdown.trim(), "utf8").digest("hex");
}

export function hiddenHashesFromEntries(entries: readonly unknown[]): Set<string> {
  const hashes = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== HIDDEN_ENTRY) continue;
    if (!candidate.data || typeof candidate.data !== "object") continue;
    const marker = candidate.data as { hashes?: unknown };
    if (!Array.isArray(marker.hashes)) continue;
    for (const hash of marker.hashes) {
      if (typeof hash === "string" && hash) hashes.add(hash);
    }
  }
  return hashes;
}

export function shouldHideAssistantMarkdown(
  markdown: string,
  context: Pick<MarkdownTransformContext, "messageType" | "isStreaming">,
  options: { enabled: boolean; buffered: boolean; hiddenHashes: ReadonlySet<string> },
): boolean {
  if (!options.buffered || context.messageType !== "assistant") return false;
  if (options.hiddenHashes.has(markdownHash(markdown))) return true;
  return options.enabled && context.isStreaming;
}

export function latestRoleMessage(messages: readonly unknown[], role: "user" | "assistant"): { text: string; index: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const candidate = message as { role?: unknown; content?: unknown };
    if (candidate.role !== role) continue;
    const text = contentText(candidate.content);
    if (text) return { text, index };
  }
  return undefined;
}

export function latestRoleText(messages: readonly unknown[], role: "user" | "assistant"): string | undefined {
  return latestRoleMessage(messages, role)?.text;
}

function formatHit(hit: ThresholdHit): string {
  return `${signalLabel(hit.signal)} ${formatScore(hit.score)} >= ${formatScore(hit.threshold)}`;
}

export function interventionLog(
  hits: readonly ThresholdHit[],
  scores: ConcisionScores,
  retry: number,
  maxRetries: number,
  elapsedMs: number,
): string {
  const reasons = hits.length
    ? hits.map(formatHit).join(", ")
    : `revise ${formatScore(scores.needsRevision)}`;
  return `${PACKAGE_NAME}: intervention ${retry}/${maxRetries} · FAIL ${reasons} · ${elapsedMs} ms`;
}

export function passLog(
  scores: ConcisionScores,
  thresholds: ConcisionThresholds,
  elapsedMs: number,
): string {
  return [
    `${PACKAGE_NAME}: revision passed`,
    `revise ${formatScore(scores.needsRevision)} < ${formatScore(thresholds.needsRevision)}`,
    `repetition ${formatScore(scores.repetition)} < ${formatScore(thresholds.repetition)}`,
    `filler ${formatScore(scores.filler)} < ${formatScore(thresholds.filler)}`,
    `over-explanation ${formatScore(scores.overExplanation)} < ${formatScore(thresholds.overExplanation)}`,
    `${elapsedMs} ms`,
  ].join(" · ");
}

function thresholdSummary(thresholds: ConcisionThresholds): string {
  return [
    `revise ${formatScore(thresholds.needsRevision)}`,
    `repetition ${formatScore(thresholds.repetition)}`,
    `filler ${formatScore(thresholds.filler)}`,
    `over-explanation ${formatScore(thresholds.overExplanation)}`,
  ].join(", ");
}

export default function conciseExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  let enabled = config.enabled;
  let retries = 0;
  let revising = false;
  let warned = false;
  let activeUserIndex: number | undefined;
  let hiddenHashes = new Set<string>();

  const publishApproved = (text: string, outcome: ApprovedAnswerData["outcome"]) => {
    if (!config.buffered || !text.trim()) return;
    pi.appendEntry<ApprovedAnswerData>(APPROVED_ENTRY, {
      text: text.trim(),
      outcome,
      timestamp: Date.now(),
    });
  };

  const markAssistantHidden = (content: unknown) => {
    if (!config.buffered) return;
    const newHashes: string[] = [];
    for (const text of contentTextParts(content)) {
      const hash = markdownHash(text);
      if (hiddenHashes.has(hash)) continue;
      hiddenHashes.add(hash);
      newHashes.push(hash);
    }
    if (newHashes.length) {
      pi.appendEntry<HiddenMarkerData>(HIDDEN_ENTRY, { hashes: newHashes });
    }
  };

  let judge: ReturnType<typeof createTypeSafe> | undefined;
  const getJudge = () => {
    if (!judge) judge = createTypeSafe({ maxRequests: config.maxRequests });
    return judge;
  };

  pi.registerEntryRenderer<ApprovedAnswerData>(APPROVED_ENTRY, (entry) => {
    const text = entry.data?.text?.trim();
    if (!text) return undefined;
    return new Markdown(text, 1, 0, getMarkdownTheme());
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    return shouldHideAssistantMarkdown(markdown, context, {
      enabled,
      buffered: config.buffered,
      hiddenHashes,
    }) ? "" : markdown;
  });

  pi.on("session_start", (_event, ctx) => {
    if (!config.buffered) return;
    hiddenHashes = hiddenHashesFromEntries(ctx.sessionManager.getBranch());
  });

  pi.on("message_end", (event) => {
    if (!enabled || !config.buffered || event.message.role !== "assistant") return;
    markAssistantHidden(event.message.content);
  });

  pi.registerCommand("concise", {
    description: "Control the Jev concision gate: /concise [status|on|off]",
    handler(args, ctx) {
      const action = args.trim().toLowerCase() || "status";
      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else if (action !== "status") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /concise [status|on|off]", "warning");
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(
          `${PACKAGE_NAME}: ${enabled ? "on" : "off"}; buffered ${config.buffered ? "on" : "off"}; thresholds: ${thresholdSummary(config.thresholds)}; max retries ${config.maxRetries}; logs ${config.logs ? "on" : "off"}.`,
          "info",
        );
      }
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled) return;

    const user = latestRoleMessage(event.messages, "user");
    const assistant = latestRoleMessage(event.messages, "assistant");
    if (!user || !assistant) {
      revising = false;
      retries = 0;
      if (ctx.hasUI) ctx.ui.setStatus(PACKAGE_NAME, undefined);
      return;
    }

    if (ctx.hasUI && config.buffered) {
      ctx.ui.setStatus(PACKAGE_NAME, "concise: checking…");
    }

    if (activeUserIndex !== user.index) {
      activeUserIndex = user.index;
      revising = false;
      retries = 0;
    }
    if (!revising) retries = 0;

    let verdict;
    try {
      verdict = await evaluateConcision(getJudge(), user.text, assistant.text, {
        thresholds: config.thresholds,
      });
    } catch (error) {
      publishApproved(assistant.text, "fail-open");
      revising = false;
      if (ctx.hasUI) ctx.ui.setStatus(PACKAGE_NAME, undefined);
      if (!warned && ctx.hasUI) {
        warned = true;
        ctx.ui.notify(
          `${PACKAGE_NAME}: Jev unavailable (${error instanceof Error ? error.message : "unknown error"}). Showing the answer unchanged.`,
          "warning",
        );
      }
      return;
    }

    if (!verdict.ok) {
      publishApproved(assistant.text, "fail-open");
      revising = false;
      if (ctx.hasUI) ctx.ui.setStatus(PACKAGE_NAME, undefined);
      if (!warned && ctx.hasUI) {
        warned = true;
        ctx.ui.notify(`${PACKAGE_NAME}: Jev check failed (${verdict.error}). Showing the answer unchanged.`, "warning");
      }
      return;
    }

    warned = false;
    if (verdict.pass) {
      publishApproved(assistant.text, "passed");
      if (revising && config.logs && ctx.hasUI) {
        ctx.ui.notify(passLog(verdict.scores, config.thresholds, verdict.elapsedMs), "info");
      }
      revising = false;
      retries = 0;
      if (ctx.hasUI) ctx.ui.setStatus(PACKAGE_NAME, undefined);
      return;
    }

    if (retries >= config.maxRetries) {
      publishApproved(assistant.text, "retry-limit");
      revising = false;
      retries = 0;
      if (ctx.hasUI) {
        ctx.ui.setStatus(PACKAGE_NAME, undefined);
        ctx.ui.notify(`${PACKAGE_NAME}: retry limit reached; showing the latest answer.`, "warning");
      }
      return;
    }

    retries += 1;
    revising = true;

    if (ctx.hasUI && config.buffered) {
      ctx.ui.setStatus(PACKAGE_NAME, `concise: retry ${retries}/${config.maxRetries}`);
    }

    if (config.logs && ctx.hasUI) {
      ctx.ui.notify(
        interventionLog(verdict.hits, verdict.scores, retries, config.maxRetries, verdict.elapsedMs),
        "warning",
      );
    }

    pi.sendMessage(
      {
        customType: PACKAGE_NAME,
        content: revisionFeedback(verdict.scores, config.thresholds),
        display: false,
      },
      {
        deliverAs: "followUp",
        triggerTurn: true,
      },
    );
  });
}
