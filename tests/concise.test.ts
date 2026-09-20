import assert from "node:assert/strict";
import test from "node:test";
import type { Judge } from "pi-typesafe";
import {
  DEFAULT_THRESHOLDS,
  evaluateConcision,
  normalizeThreshold,
  normalizeThresholds,
  revisionFeedback,
  thresholdHits,
} from "../src/concise.js";
import {
  contentTextParts,
  hiddenHashesFromEntries,
  interventionLog,
  latestRoleText,
  loadConfig,
  markdownHash,
  passLog,
  shouldHideAssistantMarkdown,
} from "../src/extension.js";

function judgeWith(scores: { needsRevision: number; repetition: number; filler: number; overExplanation: number }): Judge {
  return {
    async evaluate() {
      return {
        model: "jev-test",
        elapsedMs: 12,
        usage: { input_tokens: 10, output_tokens: 4 },
        answers: {
          needsRevision: { type: "noul", noul: scores.needsRevision },
          repetition: { type: "noul", noul: scores.repetition },
          filler: { type: "noul", noul: scores.filler },
          overExplanation: { type: "noul", noul: scores.overExplanation },
        },
      } as never;
    },
  } as unknown as Judge;
}

test("passes only when every signal is below its threshold", async () => {
  const verdict = await evaluateConcision(
    judgeWith({ needsRevision: 0.2, repetition: 0.1, filler: 0.1, overExplanation: 0.2 }),
    "How do I rename a file?",
    "Use mv old new.",
  );
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.pass, true);
    assert.deepEqual(verdict.hits, []);
  }
});

test("rejects on high filler even when needsRevision is below threshold", async () => {
  const verdict = await evaluateConcision(
    judgeWith({ needsRevision: 0.54, repetition: 0.31, filler: 0.81, overExplanation: 0.46 }),
    "Explain this.",
    "A padded answer.",
  );
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.hits.map(hit => hit.signal), ["filler"]);
  }
});

test("rejects when any configured signal reaches its threshold", () => {
  const hits = thresholdHits(
    { needsRevision: 0.59, repetition: 0.65, filler: 0.20, overExplanation: 0.70 },
    DEFAULT_THRESHOLDS,
  );
  assert.deepEqual(hits.map(hit => hit.signal), ["repetition", "overExplanation"]);
});

test("feedback names the actual threshold violations", () => {
  const text = revisionFeedback(
    { needsRevision: 0.54, repetition: 0.31, filler: 0.81, overExplanation: 0.46 },
    DEFAULT_THRESHOLDS,
  );
  assert.match(text, /filler 0\.81 >= 0\.60/);
  assert.doesNotMatch(text, /repetition 0\.31 >=/);
  assert.match(text, /do not mention this quality check/i);
});

test("intervention log names the signals that triggered the gate", () => {
  const scores = { needsRevision: 0.54, repetition: 0.31, filler: 0.81, overExplanation: 0.46 };
  const hits = thresholdHits(scores, DEFAULT_THRESHOLDS);
  const text = interventionLog(hits, scores, 1, 3, 145);
  assert.match(text, /intervention 1\/3/);
  assert.match(text, /FAIL filler 0\.81 >= 0\.60/);
  assert.match(text, /145 ms/);
});

test("pass log shows all four signals under threshold", () => {
  const text = passLog(
    { needsRevision: 0.31, repetition: 0.22, filler: 0.18, overExplanation: 0.40 },
    DEFAULT_THRESHOLDS,
    98,
  );
  assert.match(text, /revision passed/);
  assert.match(text, /revise 0\.31 < 0\.60/);
  assert.match(text, /filler 0\.18 < 0\.60/);
  assert.match(text, /98 ms/);
});

test("extracts separate assistant text blocks for renderer hashing", () => {
  assert.deepEqual(
    contentTextParts([
      { type: "text", text: " first " },
      { type: "toolCall", name: "read" },
      { type: "text", text: "second" },
    ]),
    ["first", "second"],
  );
});

test("buffered mode hides assistant streaming output", () => {
  assert.equal(
    shouldHideAssistantMarkdown("draft", { messageType: "assistant", isStreaming: true }, {
      enabled: true,
      buffered: true,
      hiddenHashes: new Set(),
    }),
    true,
  );
});

test("recorded drafts stay hidden after the gate is disabled", () => {
  const hiddenHashes = new Set([markdownHash("rejected draft")]);
  assert.equal(
    shouldHideAssistantMarkdown("rejected draft", { messageType: "assistant", isStreaming: false }, {
      enabled: false,
      buffered: true,
      hiddenHashes,
    }),
    true,
  );
});

test("user markdown is never hidden by the assistant buffer", () => {
  assert.equal(
    shouldHideAssistantMarkdown("hello", { messageType: "user", isStreaming: true }, {
      enabled: true,
      buffered: true,
      hiddenHashes: new Set([markdownHash("hello")]),
    }),
    false,
  );
});

test("hidden draft hashes restore from persisted custom entries", () => {
  const one = markdownHash("one");
  const two = markdownHash("two");
  const hashes = hiddenHashesFromEntries([
    { type: "custom", customType: "pi-jev-concise:hidden", data: { hashes: [one, two] } },
    { type: "custom", customType: "other", data: { hashes: ["ignored"] } },
  ]);
  assert.deepEqual([...hashes], [one, two]);
});

test("extracts the latest textual message by role", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
    { role: "user", content: "second" },
  ];
  assert.equal(latestRoleText(messages, "user"), "second");
  assert.equal(latestRoleText(messages, "assistant"), "answer");
});

test("invalid thresholds fall back independently", () => {
  assert.equal(normalizeThreshold(-1), 0.60);
  assert.equal(normalizeThreshold(1.2, 0.65), 0.65);
  assert.equal(normalizeThreshold(0.55), 0.55);
  assert.deepEqual(normalizeThresholds({ filler: 0.50 }), {
    needsRevision: 0.60,
    repetition: 0.65,
    filler: 0.50,
    overExplanation: 0.70,
  });
});

test("config defaults to buffered multi-signal mode with logs on", () => {
  const names = [
    "PI_JEV_CONCISE_ENABLED",
    "PI_JEV_CONCISE_LOGS",
    "PI_JEV_CONCISE_BUFFERED",
    "PI_JEV_CONCISE_THRESHOLD",
    "PI_JEV_CONCISE_REPETITION_THRESHOLD",
    "PI_JEV_CONCISE_FILLER_THRESHOLD",
    "PI_JEV_CONCISE_OVER_EXPLANATION_THRESHOLD",
  ] as const;
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const config = loadConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.logs, true);
    assert.equal(config.buffered, true);
    assert.deepEqual(config.thresholds, DEFAULT_THRESHOLDS);
  } finally {
    for (const name of names) {
      const value = old[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("individual signal thresholds can be overridden from the environment", () => {
  const old = process.env.PI_JEV_CONCISE_FILLER_THRESHOLD;
  process.env.PI_JEV_CONCISE_FILLER_THRESHOLD = "0.42";
  try {
    assert.equal(loadConfig().thresholds.filler, 0.42);
  } finally {
    if (old === undefined) delete process.env.PI_JEV_CONCISE_FILLER_THRESHOLD;
    else process.env.PI_JEV_CONCISE_FILLER_THRESHOLD = old;
  }
});
