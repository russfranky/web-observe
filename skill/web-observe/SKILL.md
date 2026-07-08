---
name: web-observe
description: Diagnose a broken local web page by causal, source-linked evidence (which console error, caused by which network failure, at which source line) instead of a screenshot. Use for a web app showing an error, blank view, dead control, failing API, or layout break. Runs on Playwright; needs ~/web-observe + chromium.
---

# web-observe — causal web diagnosis

For a web page in Chrome, structured state beats pixels. This tool goes one step
past raw structured state: it **correlates** console errors, network failures,
and DOM/a11y state into ranked, source-linked findings.

## When to use

- "Why is this page broken / blank / erroring?" on a local web app
- "Why is this button disabled / this control not working?"
- "Did my change fix the runtime error?" — as an iterate-until-clean gate
- Prefer over a screenshot+vision read for Chrome web pages; prefer over raw
  chrome-devtools-mcp calls when you want the *cause*, not just the signals.

## Command

```bash
web-observe <url> [--json] [--settle <ms>] [--timeout <ms>]
# narrative (default): ranked findings with cause + source pointer
# --json: {url, pass, findings[{severity,category,message,evidence,likelyCause,confidence}], counts, accessibility, raw}
```

Exit 0 = no error findings, 1 = has errors, 2 = usage/collection failure — gate
a fix loop on it like a failing test.

## Reading the output

Each finding names the effect, then `↳` its likely cause and `↳` the source
location. Example: a `TypeError` finding linked to a `/api/cart 401` with
`source: CartProvider.tsx:42` means fix the session/401 handling there — the
runtime error is a symptom, the 401 is the cause.

Confidence is honest: path-based error↔network links and stack→source are solid;
time-window links are labeled `low`; React component hints are best-effort.

## Where it sits

- **chrome-devtools-mcp** — raw browser signals (console/network/DOM/perf). This
  tool consumes that class of signal and adds correlation. Use its raw tools
  when you need interaction/automation or perf/heap depth.
- **ocr-check (ocr-loop)** — the pixel layer for non-Chrome surfaces (native
  apps, Simulator, other browsers) and visual content. Use when the target
  isn't a Chrome page or the question is genuinely visual.

Routing: Chrome page runtime/layout bug → web-observe. Non-Chrome or pixel
question → ocr-check. Need to click/type/trace → chrome-devtools-mcp.

## Setup if missing

```bash
cd ~/web-observe && npm install && npx playwright install chromium && npm link
```
