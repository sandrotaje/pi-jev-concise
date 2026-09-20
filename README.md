# pi-jev-concise

A [Pi](https://github.com/earendil-works/pi) extension that uses Jev through [`pi-typesafe`](https://github.com/DevMortimer/pi-typesafe) as a semantic concision gate.

By default, assistant prose is **buffered in the TUI**: draft answers are generated but not shown. Jev checks the completed answer, asks Pi for a hidden rewrite when necessary, and only the answer that passes the gate is rendered to the user.

## Install

```bash
pi install https://github.com/sandrotaje/pi-jev-concise
```

Set the TypeSafe key before starting Pi:

```bash
export TYPESAFE_API_KEY="..."
```

No login flow is implemented by this extension. It expects `TYPESAFE_API_KEY` in the environment.

## What you see

With the default buffered mode:

```text
user
  │
  ▼
Pi generates draft ───────────────┐
  │                               │ hidden in TUI
  ▼                               │
Jev concision check               │
  │                               │
  ├── FAIL → hidden feedback → Pi generates revision
  │
  └── PASS
       │
       ▼
only the approved answer is shown
```

Tool calls and tool results still use Pi's normal UI. The extension buffers assistant **text**, not tool execution.

While Jev is evaluating, the Pi status line shows `concise: checking…`. During a retry it shows `concise: retry 1/3`.

If Jev is unavailable, the request times out, or the retry limit is reached, the extension fails open and shows the latest answer rather than leaving the user with an empty response.

### Why rejected drafts stay hidden after `/reload`

Every buffered assistant text block gets a small TUI-only hash marker in the Pi session. The actual assistant message remains untouched in LLM context, while the Markdown renderer suppresses messages whose hashes were marked. The approved answer is rendered as a TUI-only custom entry.

This means rejected drafts do not reappear when the session is re-rendered or the extension is reloaded.

## How it decides

Jev evaluates the user request and assistant response together. A response passes only when **all four scores** are below their threshold:

| Signal | Reject at |
| --- | ---: |
| needs revision / compressibility | `>= 0.60` |
| repetition | `>= 0.65` |
| filler | `>= 0.60` |
| over-explanation | `>= 0.70` |

For example:

```text
needs revision      0.54
repetition          0.31
filler              0.81  <- FAIL
over-explanation    0.46
```

triggers a rewrite even though the general compressibility score is below its threshold.

The main compressibility question is relative to the user's request, so a long response can still pass when the task genuinely requires detail.

## Logs

Intervention logs are enabled by default. A rejection looks like:

```text
pi-jev-concise: intervention 1/3 · FAIL filler 0.81 >= 0.60 · 184 ms
```

If several signals trigger the gate:

```text
pi-jev-concise: intervention 1/3 · FAIL revise 0.74 >= 0.60, repetition 0.72 >= 0.65 · 176 ms
```

A successful retry reports that the revision passed.

## Configuration

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `TYPESAFE_API_KEY` | required | TypeSafe/Jev API key |
| `PI_JEV_CONCISE_ENABLED` | `true` | Start the gate enabled |
| `PI_JEV_CONCISE_BUFFERED` | `true` | Hide assistant drafts and show only the approved/fallback answer |
| `PI_JEV_CONCISE_LOGS` | `true` | Show intervention/pass notifications |
| `PI_JEV_CONCISE_THRESHOLD` | `0.60` | needs-revision threshold |
| `PI_JEV_CONCISE_REPETITION_THRESHOLD` | `0.65` | repetition threshold |
| `PI_JEV_CONCISE_FILLER_THRESHOLD` | `0.60` | filler threshold |
| `PI_JEV_CONCISE_OVER_EXPLANATION_THRESHOLD` | `0.70` | over-explanation threshold |
| `PI_JEV_CONCISE_MAX_RETRIES` | `3` | Maximum automatic rewrites per user turn |
| `PI_JEV_CONCISE_MAX_REQUESTS` | `1000` | Maximum Jev requests per extension instance |

To restore the old behavior where drafts remain visible:

```bash
export PI_JEV_CONCISE_BUFFERED=false
```

Inside Pi:

```text
/concise status
/concise on
/concise off
```

`/concise status` reports buffered mode, all four thresholds, retry count, and logs.

## Data sent to Jev

For each completed answer, the extension sends the **current user request** and the **latest assistant response** to TypeSafe (`api.typesafe.ai`). It does not send the full Pi conversation history.

The hidden-draft markers contain SHA-256 hashes only and do not participate in LLM context. Approved TUI entries also do not participate in LLM context; the original assistant message remains in Pi's normal conversation context.

## Development

Requires Node.js 22.19+.

```bash
npm install
npm run check
```

`npm run check` runs typecheck, offline tests, and the production build. Tests mock Jev and do not spend TypeSafe requests.

## Design principle

Jev decides **whether to revise**. Pi decides **how to write**. Draft presentation is separate from conversation context: the model keeps its normal assistant messages, while the TUI shows only the approved answer.

## License

MIT
