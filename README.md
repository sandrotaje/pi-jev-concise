# pi-jev-concise

A small [Pi](https://github.com/earendil-works/pi) extension that uses Jev through [`pi-typesafe`](https://github.com/DevMortimer/pi-typesafe) as a semantic concision gate.

Pi answers normally. When an answer is finished, Jev checks four independent signals: whether the response should be materially compressed, repetition, filler, and over-explanation. If **any** signal crosses its threshold, the extension sends a hidden revision instruction back to Pi and starts another turn.

The original answer stays visible in the TUI; the final visible assistant message is the revised one that passed the gate (or the last retry if the retry cap is reached).

## Install

```bash
pi install https://github.com/sandrotaje/pi-jev-concise
```

Set the TypeSafe key before starting Pi:

```bash
export TYPESAFE_API_KEY="..."
```

No login flow is implemented by this extension. It expects `TYPESAFE_API_KEY` to be available in the environment.

## How it decides

Jev evaluates the user request and the assistant response together.

The default thresholds are:

| Signal | Reject at |
| --- | ---: |
| needs revision / compressibility | `>= 0.60` |
| repetition | `>= 0.65` |
| filler | `>= 0.60` |
| over-explanation | `>= 0.70` |

A response passes only when **all four scores are below their threshold**.

For example, this now triggers a rewrite:

```text
needs revision      0.54
repetition          0.31
filler              0.81  <- FAIL
over-explanation    0.46
```

The main compressibility question is still relative to the user's request:

> Could the assistant response be made materially shorter while satisfying the user's request equally well, without losing useful information, precision, caveats, or actionable details?

So a long response can pass when the task genuinely requires detail.

## TUI behavior and logs

`pi-jev-concise` does **not** buffer or replace Pi's TUI. You may see the original response and one or more revisions.

The technical revision feedback is a Pi custom message with `display: false`, so it participates in model context without adding noise to the transcript.

Intervention logs are enabled by default. When one signal triggers the gate:

```text
pi-jev-concise: intervention 1/3 · FAIL filler 0.81 >= 0.60 · 184 ms
```

If several signals trigger it, they are all shown:

```text
pi-jev-concise: intervention 1/3 · FAIL revise 0.74 >= 0.60, repetition 0.72 >= 0.65 · 176 ms
```

When a rewritten answer passes, the notification shows all four scores below threshold.

## Configuration

All configuration is optional.

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `TYPESAFE_API_KEY` | required | TypeSafe/Jev API key |
| `PI_JEV_CONCISE_ENABLED` | `true` | Set to `false` to start disabled |
| `PI_JEV_CONCISE_LOGS` | `true` | Set to `false` to hide intervention/pass notifications |
| `PI_JEV_CONCISE_THRESHOLD` | `0.60` | needs-revision threshold (kept for backward compatibility) |
| `PI_JEV_CONCISE_REPETITION_THRESHOLD` | `0.65` | repetition threshold |
| `PI_JEV_CONCISE_FILLER_THRESHOLD` | `0.60` | filler threshold |
| `PI_JEV_CONCISE_OVER_EXPLANATION_THRESHOLD` | `0.70` | over-explanation threshold |
| `PI_JEV_CONCISE_MAX_RETRIES` | `3` | Maximum automatic rewrites for one user turn |
| `PI_JEV_CONCISE_MAX_REQUESTS` | `1000` | Maximum Jev requests for this extension instance |

Inside Pi:

```text
/concise status
/concise on
/concise off
```

`/concise status` reports all four active thresholds.

## Data sent to Jev

For each completed answer, the extension sends the **current user request** and the **latest assistant response** to TypeSafe (`api.typesafe.ai`) for evaluation. It does not send your full Pi conversation history. Jev returns fixed probability judgments; the extension, not Jev, decides whether to trigger another Pi turn.

## Failure behavior

The gate is fail-open. If the API key is missing, Jev fails or times out, or the request budget is exhausted, Pi's answer remains untouched and the TUI emits a warning.

A retry cap prevents pathological rewrite loops. When the cap is reached, the latest answer is kept.

## Development

Requires Node.js 22.19+.

```bash
npm install
npm run check
```

`npm run check` runs the TypeScript typecheck, offline unit tests, and production build. Tests mock Jev and do not spend TypeSafe requests.

## Design principle

Jev decides **whether to revise**. Pi decides **how to write**.

The gate optimizes signal-to-noise rather than blindly preferring short answers.

## License

MIT
