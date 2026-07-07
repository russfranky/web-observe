// Integration test: serve the broken fixture (with a stubbed 401 on /api/cart),
// run the real Playwright collector + normalizer, and assert the causal chain
// is recovered end-to-end. Skips gracefully if chromium isn't installed.
//
//   node --test test/integration.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

let collect;
try { ({ collect } = require('../src/collect.js')); } catch { /* handled below */ }

function startServer() {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'broken.html'), 'utf8');
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/cart')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function chromiumAvailable() {
  try { const { chromium } = require('playwright'); const b = await chromium.launch(); await b.close(); return true; }
  catch { return false; }
}

test('end-to-end: recovers the 401 -> TypeError causal chain and DOM findings', async (t) => {
  if (!(await chromiumAvailable())) { t.skip('chromium not installed'); return; }
  const { buildFindings } = require('../src/correlate.js');
  const server = await startServer();
  const port = server.address().port;
  try {
    const obs = await collect(`http://127.0.0.1:${port}/`, { settleMs: 500 });

    // raw signals present
    assert.ok(obs.network.some((n) => /\/api\/cart/.test(n.url) && n.status === 401), 'saw the 401');
    assert.ok(obs.console.some((c) => c.level === 'error'), 'saw a console error');

    const findings = buildFindings(obs);

    // the top finding should be the runtime error linked to the 401
    const linked = findings.find((f) => f.evidence?.network && /\/api\/cart/.test(f.evidence.network.url));
    assert.ok(linked, 'a finding links the error to /api/cart');
    assert.equal(linked.evidence.network.status, 401);
    assert.ok(/network/i.test(linked.likelyCause || ''), 'names the network cause');

    // DOM findings: disabled Checkout, unlabeled icon button, sidebar overflow
    const cats = new Set(findings.map((f) => f.category));
    assert.ok(findings.some((f) => f.category === 'ui-state' && /disabled/.test(f.message)), 'disabled button');
    assert.ok(findings.some((f) => f.category === 'a11y' && /accessible name/.test(f.message)), 'unlabeled button');
    assert.ok(findings.some((f) => f.category === 'layout' && /overflow/.test(f.message)), 'overflow');
    assert.ok(cats.size >= 3, 'multiple finding categories');
  } finally {
    server.close();
  }
});
