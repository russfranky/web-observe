// correlate.js — the semantic normalizer.
//
// Turns raw browser observations (console errors, network events, DOM/a11y
// findings) into a causal, source-linked explanation. These are PURE functions:
// no browser, no I/O — so the correlation logic is unit-testable in isolation.
// The Playwright collector (collect.js) feeds them; observe.js assembles output.

'use strict';

// --- stack traces --------------------------------------------------------

// Parse a V8/Chrome stack string into frames {fn, url, line, col}.
// Handles "at fn (url:line:col)" and "at url:line:col".
function parseStack(stack) {
  if (!stack || typeof stack !== 'string') return [];
  const frames = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    let m = line.match(/^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/);
    if (m) {
      frames.push({ fn: m[1], url: m[2], line: +m[3], col: +m[4] });
      continue;
    }
    m = line.match(/^at\s+(.+?):(\d+):(\d+)$/);
    if (m) frames.push({ fn: '<anonymous>', url: m[1], line: +m[2], col: +m[3] });
  }
  return frames;
}

// Pick the first frame that belongs to app code (not vendored / runtime).
function appFrame(frames, opts = {}) {
  const vendor = opts.vendorPatterns || [
    /node_modules/, /\/vendor\//, /webpack\/runtime/, /\bchunk-vendors\b/,
    /^https?:\/\/[^/]+\/?$/, // bare origin
  ];
  return frames.find((f) => f.url && !vendor.some((re) => re.test(f.url))) || frames[0] || null;
}

// --- console <-> network causal correlation ------------------------------

// Extract URL path fragments an error message/stack references (e.g. "/api/cart").
function referencedPaths(text) {
  if (!text) return [];
  const out = new Set();
  const re = /\/[A-Za-z0-9._~%\-/]+/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[0];
    if (p.length > 1 && !/\.(js|ts|jsx|tsx|css|map)(:|$)/.test(p)) out.add(p.replace(/[).,;]+$/, ''));
  }
  return [...out];
}

// For a console error, find the network failure most likely to have caused it.
// Scoring: a failure whose URL path is named in the error is a strong link;
// otherwise the nearest-preceding failure within `windowMs` is a weak link.
function linkErrorToNetwork(error, networkFailures, opts = {}) {
  const windowMs = opts.windowMs ?? 3000;
  const errText = `${error.message || ''}\n${error.stack || ''}`;
  const paths = referencedPaths(errText);
  let best = null;

  for (const nf of networkFailures) {
    const precedes = nf.timestamp <= error.timestamp;
    const dt = error.timestamp - nf.timestamp;
    let score = 0;
    let reason = '';

    const nfPath = safePath(nf.url);
    if (nfPath && paths.some((p) => nfPath === p || nfPath.startsWith(p) || p.startsWith(nfPath))) {
      score = 100; // error explicitly references this endpoint's path
      reason = `error references ${nfPath}`;
    } else if (precedes && dt <= windowMs) {
      score = Math.max(1, 60 - Math.floor((dt / windowMs) * 60)); // closer in time = higher
      reason = `${nf.status || 'failed'} on ${nfPath} ${dt}ms before the error`;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { network: nf, score, reason, strong: score >= 100 };
    }
  }
  return best;
}

function safePath(url) {
  try { return new URL(url).pathname; } catch { return null; }
}

// --- findings assembly ---------------------------------------------------

// Build a ranked findings list from raw observations. Each finding carries
// evidence + a likely cause + a source pointer where one can be derived.
function buildFindings(obs, opts = {}) {
  const findings = [];
  const netFailures = (obs.network || []).filter((n) => n.failed || (n.status && n.status >= 400));

  for (const err of obs.console || []) {
    if (err.level !== 'error') continue;
    const frames = parseStack(err.stack);
    const src = appFrame(frames, opts);
    const link = linkErrorToNetwork(err, netFailures, opts);
    const f = {
      severity: 'error',
      category: 'runtime',
      message: err.message,
      evidence: {},
    };
    if (src) f.evidence.source = `${src.url}:${src.line}:${src.col}` + (src.fn ? ` (${src.fn})` : '');
    if (link) {
      f.category = 'runtime+network';
      f.likelyCause = link.strong
        ? `Network failure — ${link.reason}`
        : `Possibly caused by a network failure — ${link.reason}`;
      f.evidence.network = { url: link.network.url, status: link.network.status || 'failed' };
      f.confidence = link.strong ? 'high' : 'low';
    } else {
      f.confidence = src ? 'medium' : 'low';
    }
    findings.push(f);
  }

  // Orphan network failures (no console error linked) are still worth surfacing.
  const linkedUrls = new Set(
    findings.flatMap((f) => (f.evidence.network ? [f.evidence.network.url] : []))
  );
  for (const nf of netFailures) {
    if (linkedUrls.has(nf.url)) continue;
    findings.push({
      severity: nf.status >= 500 ? 'error' : 'warning',
      category: 'network',
      message: `${nf.status || 'Request failed'} ${nf.method || 'GET'} ${nf.url}`,
      evidence: { network: { url: nf.url, status: nf.status || 'failed' } },
      confidence: 'high',
    });
  }

  // DOM/a11y findings pass through, already structured by the collector.
  for (const d of obs.dom || []) findings.push(d);

  return rankFindings(findings);
}

const SEV_RANK = { error: 0, warning: 1, info: 2 };
const CONF_RANK = { high: 0, medium: 1, low: 2 };
function rankFindings(findings) {
  return [...findings].sort((a, b) => {
    const s = (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3);
    if (s) return s;
    return (CONF_RANK[a.confidence] ?? 3) - (CONF_RANK[b.confidence] ?? 3);
  });
}

// --- narrative -----------------------------------------------------------

// One-line-per-finding human/AI-readable summary. This is what an agent reads
// instead of a screenshot: cause + evidence + where to look.
function narrate(findings) {
  if (!findings.length) return 'No errors, failed requests, or a11y issues observed.';
  const lines = [];
  for (const f of findings) {
    let line = `[${f.severity}] ${f.message}`;
    if (f.likelyCause) line += `\n  ↳ ${f.likelyCause}`;
    if (f.evidence?.source) line += `\n  ↳ source: ${f.evidence.source}`;
    if (f.evidence?.selector) line += `\n  ↳ selector: ${f.evidence.selector}`;
    if (f.confidence) line += `  (confidence: ${f.confidence})`;
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = {
  parseStack,
  appFrame,
  referencedPaths,
  linkErrorToNetwork,
  buildFindings,
  rankFindings,
  narrate,
  safePath,
};
