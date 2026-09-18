import assert from "node:assert/strict";
import test from "node:test";
import type { Judge } from "pi-typesafe";
import { evaluateConcision, normalizeThreshold, revisionFeedback } from "../src/concise.js";
import { latestRoleText, loadConfig } from "../src/extension.js";

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

test("passes below the revision threshold", async () => {
  const verdict = await evaluateConcision(
    judgeWith({ needsRevision: 0.2, repetition: 0.1, filler: 0.1, overExplanation: 0.2 }),
    "How do I rename a file?",
    "Use mv old new.",
  );
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.pass, true);
});

test("rejects at or above the revision threshold", async () => {
  const verdict = await evaluateConcision(
    judgeWith({ needsRevision: 0.9, repetition: 0.8, filler: 0.7, overExplanation: 0.6 }),
    "How do I rename a file?",
    "A very long answer.",
  );
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.pass, false);
});

test("feedback names detected sources of verbosity", () => {
  const text = revisionFeedback({ needsRevision: 0.92, repetition: 0.8, filler: 0.7, overExplanation: 0.2 });
  assert.match(text, /repetition 0\.80/);
  assert.match(text, /filler 0\.70/);
  assert.match(text, /do not mention this quality check/i);
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

test("invalid thresholds fall back to the default", () => {
  assert.equal(normalizeThreshold(-1), 0.72);
  assert.equal(normalizeThreshold(1.2), 0.72);
  assert.equal(normalizeThreshold(0.6), 0.6);
});

test("config defaults to enabled", () => {
  const old = process.env.PI_JEV_CONCISE_ENABLED;
  delete process.env.PI_JEV_CONCISE_ENABLED;
  try {
    assert.equal(loadConfig().enabled, true);
  } finally {
    if (old === undefined) delete process.env.PI_JEV_CONCISE_ENABLED;
    else process.env.PI_JEV_CONCISE_ENABLED = old;
  }
});
