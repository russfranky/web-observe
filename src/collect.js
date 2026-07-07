// collect.js — Playwright collector. Navigates a URL, records the raw browser
// observations the normalizer needs: console messages, network events, an
// accessibility snapshot, and an in-page DOM/a11y/layout scan.
//
// This is the "lower layer" the analysis calls chrome-devtools-mcp's job. We
// implement it directly on Playwright so web-observe runs standalone (no MCP
// client required), but the normalizer (correlate.js) is agnostic to the
// source — you could feed it chrome-devtools-mcp output instead.

'use strict';

// The in-page scan. Passed BY REFERENCE to page.evaluate so it runs in the
// browser context (has `document`), not in Node. Returns structured DOM
// findings (disabled controls, overflow, unlabeled interactive elements) plus
// best-effort framework component hints. Serializable return only.
function domScan() {
  /* eslint-disable */
  {
    const findings = [];
    const sel = (el) => {
      if (el.id) return `#${el.id}`;
      const tid = el.getAttribute('data-testid');
      if (tid) return `[data-testid="${tid}"]`;
      const cls = (el.className && typeof el.className === 'string')
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return el.tagName.toLowerCase() + cls;
    };
    // best-effort: nearest React component displayName via fiber
    const reactComponent = (el) => {
      let node = el;
      for (let hop = 0; node && hop < 30; hop++, node = node.parentElement) {
        const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!key) continue;
        let fiber = node[key];
        for (let up = 0; fiber && up < 40; up++, fiber = fiber.return) {
          const t = fiber.type;
          const name = typeof t === 'function' ? (t.displayName || t.name)
            : (t && (t.displayName || t.name));
          if (name && /^[A-Z]/.test(name)) return name;
        }
      }
      return null;
    };
    const withHint = (ev, el) => { const c = reactComponent(el); if (c) ev.component = c; return ev; };

    // disabled interactive controls (a common "why can't I click it" cause)
    document.querySelectorAll('button, [role="button"], input, a[href]').forEach((el) => {
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
      if (disabled) findings.push(withHint({
        severity: 'info', category: 'ui-state',
        message: `${el.tagName.toLowerCase()} "${(el.textContent || el.value || '').trim().slice(0, 40)}" is disabled`,
        evidence: { selector: sel(el) }, confidence: 'high',
      }, el));
    });

    // interactive elements with no accessible name (real a11y defect)
    document.querySelectorAll('button, [role="button"], a[href]').forEach((el) => {
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim();
      if (!name) findings.push(withHint({
        severity: 'warning', category: 'a11y',
        message: `${el.tagName.toLowerCase()} has no accessible name`,
        evidence: { selector: sel(el) }, confidence: 'high',
      }, el));
    });

    // horizontal overflow (layout breakage)
    document.querySelectorAll('*').forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 8 && el.clientWidth > 0) {
        const cs = getComputedStyle(el);
        if (cs.overflowX === 'visible' || cs.overflowX === 'hidden') {
          findings.push(withHint({
            severity: 'warning', category: 'layout',
            message: `horizontal overflow (${el.scrollWidth}px content in ${el.clientWidth}px box)`,
            evidence: { selector: sel(el), computed: { width: cs.width, overflowX: cs.overflowX } },
            confidence: 'medium',
          }, el));
        }
      }
    });

    return findings.slice(0, 50);
  }
  /* eslint-enable */
}

async function collect(url, opts = {}) {
  const { chromium } = require('playwright');
  const started = opts.now ? opts.now() : Date.now();
  const consoleMsgs = [];
  const network = [];

  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    page.on('console', (msg) => {
      const loc = msg.location();
      consoleMsgs.push({
        level: msg.type() === 'error' ? 'error' : msg.type() === 'warning' ? 'warning' : 'info',
        message: msg.text(),
        stack: loc.url ? `    at ${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : '',
        timestamp: Date.now(),
      });
    });
    page.on('pageerror', (err) => {
      consoleMsgs.push({ level: 'error', message: err.message, stack: err.stack || '', timestamp: Date.now() });
    });
    page.on('response', (res) => {
      const s = res.status();
      if (s >= 400) network.push({ url: res.url(), method: res.request().method(), status: s, failed: false, timestamp: Date.now() });
    });
    page.on('requestfailed', (req) => {
      network.push({ url: req.url(), method: req.method(), status: null, failed: true, timestamp: Date.now(), error: req.failure()?.errorText });
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: opts.timeout || 30000 });
    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);

    let aria = '';
    try { aria = await page.locator('body').ariaSnapshot(); } catch { /* older PW */ }
    const dom = await page.evaluate(domScan);

    return {
      url,
      finalUrl: page.url(),
      startedAt: started,
      console: consoleMsgs,
      network,
      accessibility: aria,
      dom,
    };
  } finally {
    await browser.close();
  }
}

module.exports = { collect, domScan };
