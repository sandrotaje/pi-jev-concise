# pi-jev-concise

A small [Pi](https://github.com/earendil-works/pi) extension that uses Jev through [`pi-typesafe`](https://github.com/DevMortimer/pi-typesafe) as a semantic concision gate.

Pi answers normally. When an answer is finished, Jev checks whether it could be **materially shorter without losing useful information, precision, caveats, or actionable detail**. If the answer fails, the extension sends a hidden revision instruction back to Pi and starts another turn. The original answer stays visible in the TUI; the final visible assistant message is the revised one that passed the gate (or the last retry if the retry cap is reached).

## Install

```bash
pi install https://github.com/sandrotaje/pi-jev-concise
```

Set the TypeSafe key before starting Pi:

```bash
export TYPESAFE_API_KEY="..."
```

No login flow is implemented by this extension. It expects `TYPESAFE_API_KEY` to be available in the environment.

## How it works

```text
user
  │
  ▼
Pi / LLM
  │
  ▼
visible answer
  │
  ▼
Jev concision check
  │
  ├── pass ─────────────► stop
  │
  └── fail
       │
       ▼
hidden revision feedback
       │
       ▼
Pi / LLM
       │
       └──────────────► check again
```

The main Jev question is intentionally relative to the user's request:

> Could the assistant response be made materially shorter while satisfying the user's request equally well, without losing useful information, precision, caveats, or actionable details?

That means a long answer can pass when the task actually requires detail. The extension is not a character-count limiter.

Jev also returns separate probabilities for repetition, filler, and over-explanation. Those signals are included in the hidden revision feedback so Pi knows what to remove.

## TUI behavior and logs

`pi-jev-concise` does **not** buffer or replace Pi's TUI. You may see:

1. the original verbose answer;
2. a shorter revision;
3. another revision if necessary.

The technical Jev feedback uses a Pi custom message with `display: false`, so it participates in model context without adding noise to the transcript.

Intervention logs are enabled by default. When Jev rejects an answer, Pi shows a TUI notification like:

```text
pi-jev-concise: intervention 1/3 · revise 0.91 >= 0.72 · repetition 0.80 · filler 0.67 · over-explanation 0.31 · 184 ms
```

When a rewritten answer passes:

```text
pi-jev-concise: revision passed · revise 0.24 < 0.72 · 151 ms
```

So you can tell exactly when the extension intervened without making the hidden revision prompt visible.

## Configuration

All configuration is optional.

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `TYPESAFE_API_KEY` | required | TypeSafe/Jev API key |
| `PI_JEV_CONCISE_ENABLED` | `true` | Set to `false` to start disabled |
| `PI_JEV_CONCISE_LOGS` | `true` | Set to `false` to hide intervention/pass notifications |
| `PI_JEV_CONCISE_THRESHOLD` | `0.72` | Reject when `P(needs revision)` is at least this value |
| `PI_JEV_CONCISE_MAX_RETRIES` | `3` | Maximum automatic rewrites for one user turn |
| `PI_JEV_CONCISE_MAX_REQUESTS` | `1000` | Maximum Jev requests for this extension instance |

Inside Pi:

```text
/concise status
/concise on
/concise off
```

`/concise status` also reports whether intervention logs are enabled.

The `on`/`off` setting is session-local. Use the environment variable for a persistent startup default.

## Data sent to Jev

For each completed answer, the extension sends the **current user request** and the **latest assistant response** to TypeSafe (`api.typesafe.ai`) for evaluation. It does not send your full Pi conversation history. Jev returns fixed probability judgments; the extension, not Jev, decides whether to trigger another Pi turn.

## Failure behavior

The gate is deliberately fail-open:

- if `TYPESAFE_API_KEY` is missing;
- if Jev times out or returns an integration error;
- if the request budget is exhausted;

Pi's answer remains untouched. In TUI mode the extension emits one warning rather than blocking the conversation.

A retry cap prevents pathological rewrite loops. When the cap is reached, the latest answer is kept.

## Development

Requires Node.js 22.19+.

```bash
npm install
npm run check
```

`npm run check` runs the TypeScript typecheck, offline unit tests, and the production build. The tests mock the Jev transport; they do not spend TypeSafe requests.

## Design principle

Jev decides **whether to revise**. Pi decides **how to write**.

The gate evaluates `(user request, assistant response)` together, so it optimizes signal-to-noise rather than blindly preferring short answers.

## License

MIT
