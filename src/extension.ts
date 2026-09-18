import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTypeSafe } from "pi-typesafe";
import {
  evaluateConcision,
  normalizeThreshold,
  revisionFeedback,
} from "./concise.js";

const PACKAGE_NAME = "pi-jev-concise";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_REQUESTS = 1_000;

interface RuntimeConfig {
  enabled: boolean;
  threshold: number;
  maxRetries: number;
  maxRequests: number;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function loadConfig(): RuntimeConfig {
  return {
    enabled: process.env.PI_JEV_CONCISE_ENABLED?.trim().toLowerCase() !== "false",
    threshold: normalizeThreshold(envNumber("PI_JEV_CONCISE_THRESHOLD")),
    maxRetries: positiveInteger(envNumber("PI_JEV_CONCISE_MAX_RETRIES"), DEFAULT_MAX_RETRIES),
    maxRequests: positiveInteger(envNumber("PI_JEV_CONCISE_MAX_REQUESTS"), DEFAULT_MAX_REQUESTS),
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap(part => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
    })
    .join("\n")
    .trim();
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

export default function conciseExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  let enabled = config.enabled;
  let retries = 0;
  let revising = false;
  let warned = false;
  let activeUserIndex: number | undefined;

  let judge: ReturnType<typeof createTypeSafe> | undefined;
  const getJudge = () => {
    if (!judge) judge = createTypeSafe({ maxRequests: config.maxRequests });
    return judge;
  };

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
          `${PACKAGE_NAME}: ${enabled ? "on" : "off"}; threshold ${config.threshold.toFixed(2)}; max retries ${config.maxRetries}.`,
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
      return;
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
        threshold: config.threshold,
      });
    } catch (error) {
      revising = false;
      if (!warned && ctx.hasUI) {
        warned = true;
        ctx.ui.notify(
          `${PACKAGE_NAME}: Jev unavailable (${error instanceof Error ? error.message : "unknown error"}). Responses will pass through unchanged.`,
          "warning",
        );
      }
      return;
    }

    if (!verdict.ok) {
      revising = false;
      if (!warned && ctx.hasUI) {
        warned = true;
        ctx.ui.notify(`${PACKAGE_NAME}: Jev check failed (${verdict.error}). Responses will pass through unchanged.`, "warning");
      }
      return;
    }

    warned = false;
    if (verdict.pass) {
      revising = false;
      retries = 0;
      return;
    }

    if (retries >= config.maxRetries) {
      revising = false;
      retries = 0;
      if (ctx.hasUI) ctx.ui.notify(`${PACKAGE_NAME}: retry limit reached; keeping the latest answer.`, "warning");
      return;
    }

    retries += 1;
    revising = true;

    pi.sendMessage(
      {
        customType: PACKAGE_NAME,
        content: revisionFeedback(verdict.scores),
        display: false,
      },
      {
        deliverAs: "followUp",
        triggerTurn: true,
      },
    );
  });
}
