# web-observe

The semantic layer above browser instrumentation. Turns raw browser
observations — console errors, network failures, DOM/accessibility state — into
a **single causal, source-linked explanation** an AI coding agent can act on,
instead of a screenshot it has to infer from.

```
$ web-observe http://localhost:3000
FAIL  http://localhost:3000
[error] Cannot read cart from /api/cart: Cannot read properties of undefined (reading 'length')
  ↳ Network failure — error references /api/cart
  ↳ source: http://localhost:3000/:23:29  (confidence: high)
[warning] button has no accessible name
  ↳ selector: #icon-only  (confidence: high)
[warning] horizontal overflow (900px content in 300px box)
  ↳ selector: [data-testid="sidebar"]  (confidence: medium)
[info] button "Checkout" is disabled
  ↳ selector: #checkout  (confidence: high)
```

## Where this fits

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(and Playwright/CDP) get an agent *close* to a semantic feedback loop: they
expose console, network, DOM/accessibility, and performance as raw
observations. What they don't do is **correlate** those into cause-and-effect
tied back to your source. That last hop — "this TypeError was caused by that
401, and it's on line 23" — is the differentiated layer, and it's what this is.

```
browser runtime (chrome-devtools-mcp / Playwright / CDP)
        ↓  raw observations: console · network · a11y · DOM · layout
web-observe normalizer
        ↓  correlate: stack → source · error ↔ network by path+time · DOM → cause
AI-readable findings
        "TypeError on CartProvider.tsx:42 — caused by /api/cart 401. Fix session handling."
```

It runs **standalone on Playwright** (no MCP client needed), but the normalizer
([`src/correlate.js`](src/correlate.js)) is source-agnostic: feed it
chrome-devtools-mcp's console/network output and it produces the same findings.

## Install

```bash
git clone https://github.com/russfranky/web-observe.git && cd web-observe
npm install && npx playwright install chromium
npm link            # optional: puts `web-observe` on PATH
```

## Use

```bash
web-observe <url> [--json] [--settle <ms>] [--timeout <ms>]

web-observe http://localhost:3000                 # narrative
web-observe http://localhost:3000 --json          # full WebDevObservation blob
web-observe http://localhost:3000 --settle 12000  # wait for a slow SPA to boot
```

Exit code: **0** = no error-severity findings, **1** = at least one error, **2**
= usage/collection failure. So it gates like a test in an iterate-until-clean
loop, same as a failing spec.

`--json` emits `{ url, pass, findings[], counts, accessibility, raw }` — the
`findings` array is ranked (errors first, then by confidence) and each entry
carries `{ severity, category, message, evidence{source,network,selector,component}, likelyCause, confidence }`.

## What it correlates (and how confident)

| Correlation | How | Confidence |
|---|---|---|
| console error → source file:line | parse stack, pick first app frame (skips `node_modules`/vendor) | solid |
| console error → causing network failure | error text names the endpoint path → **strong**; else nearest preceding failure within a time window → weak | solid (path) / heuristic (time) |
| orphan network failures (4xx/5xx) | surfaced even with no linked error | solid |
| DOM: disabled controls, unlabeled interactive elements, horizontal overflow | in-page scan with computed styles | solid |
| DOM node → framework component | best-effort React fiber walk (`__reactFiber$`) | **best-effort** — present when detectable, absent otherwise |

Honest about boundaries: stack→source and path-based error↔network links are
deterministic. Time-window links are a labeled heuristic (`confidence: low`).
Framework mapping is best-effort and React-first; it never fabricates a
component name. Patch *generation* is deliberately left to the agent consuming
the blob — this tool produces evidence and causality, not code.

## Test

```bash
npm test    # unit (correlation logic, no browser) + integration (real Playwright vs a broken fixture)
```

The integration test serves a page that 401s on `/api/cart` then throws, and
asserts the 401→TypeError chain plus the DOM findings are recovered end-to-end.

## License

MIT
