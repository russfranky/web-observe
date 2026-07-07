// Unit tests for the pure correlation logic — no browser needed.
//   node --test test/correlate.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseStack, appFrame, referencedPaths, linkErrorToNetwork, buildFindings, narrate,
} = require('../src/correlate.js');

test('parseStack handles "at fn (url:line:col)" and bare frames', () => {
  const stack = [
    'TypeError: x is undefined',
    '    at CartProvider (https://app.test/src/CartProvider.tsx:42:13)',
    '    at https://app.test/vendor/react.js:100:5',
  ].join('\n');
  const frames = parseStack(stack);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { fn: 'CartProvider', url: 'https://app.test/src/CartProvider.tsx', line: 42, col: 13 });
  assert.equal(frames[1].fn, '<anonymous>');
});

test('appFrame skips vendor/node_modules frames', () => {
  const frames = parseStack([
    '    at r (https://app.test/node_modules/react-dom/index.js:9:9)',
    '    at Checkout (https://app.test/src/Checkout.tsx:12:3)',
  ].join('\n'));
  assert.equal(appFrame(frames).url, 'https://app.test/src/Checkout.tsx');
});

test('referencedPaths extracts API paths, ignores source files', () => {
  const paths = referencedPaths("fetch failed for /api/cart and also /api/user/me at foo.js:1:2");
  assert.ok(paths.includes('/api/cart'));
  assert.ok(paths.includes('/api/user/me'));
  assert.ok(!paths.some((p) => p.endsWith('.js')));
});

test('linkErrorToNetwork: strong link when error names the endpoint path', () => {
  const err = { message: "Cannot read 'name' after /api/cart", stack: '', timestamp: 5000 };
  const net = [
    { url: 'https://app.test/api/cart', status: 401, timestamp: 4000, failed: true },
    { url: 'https://app.test/api/other', status: 500, timestamp: 4900, failed: true },
  ];
  const link = linkErrorToNetwork(err, net);
  assert.equal(link.strong, true);
  assert.equal(link.network.url, 'https://app.test/api/cart');
});

test('linkErrorToNetwork: weak link falls back to nearest preceding failure in window', () => {
  const err = { message: 'undefined is not a function', stack: '', timestamp: 5000 };
  const net = [
    { url: 'https://app.test/api/x', status: 500, timestamp: 4800, failed: true }, // 200ms before
    { url: 'https://app.test/api/y', status: 500, timestamp: 1000, failed: true }, // too old
  ];
  const link = linkErrorToNetwork(err, net, { windowMs: 3000 });
  assert.equal(link.strong, false);
  assert.equal(link.network.url, 'https://app.test/api/x');
});

test('linkErrorToNetwork: no link when failure comes AFTER the error', () => {
  const err = { message: 'boom', stack: '', timestamp: 1000 };
  const net = [{ url: 'https://app.test/api/x', status: 500, timestamp: 2000, failed: true }];
  assert.equal(linkErrorToNetwork(err, net), null);
});

test('buildFindings: correlates a console error to its causing 401 and points at source', () => {
  const obs = {
    console: [{
      level: 'error',
      message: "TypeError: cart is undefined (/api/cart)",
      stack: '    at CartProvider (https://app.test/src/CartProvider.tsx:42:13)',
      timestamp: 5000,
    }],
    network: [{ url: 'https://app.test/api/cart', method: 'GET', status: 401, timestamp: 4800, failed: true }],
    dom: [],
  };
  const findings = buildFindings(obs);
  const top = findings[0];
  assert.equal(top.severity, 'error');
  assert.equal(top.confidence, 'high');
  assert.match(top.likelyCause, /Network failure/);
  assert.match(top.evidence.source, /CartProvider\.tsx:42:13/);
  assert.equal(top.evidence.network.status, 401);
  // the 401 must NOT also appear as an orphan finding (it was linked)
  assert.equal(findings.filter((f) => f.category === 'network').length, 0);
});

test('buildFindings: surfaces orphan network failures with no linked error', () => {
  const obs = { console: [], network: [{ url: 'https://app.test/api/z', status: 503, timestamp: 1, failed: true }], dom: [] };
  const findings = buildFindings(obs);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'network');
  assert.equal(findings[0].severity, 'error'); // 5xx
});

test('buildFindings ranks errors above warnings, high confidence first', () => {
  const obs = {
    console: [{ level: 'error', message: 'e', stack: '', timestamp: 10 }],
    network: [{ url: 'https://a/api', status: 404, timestamp: 1, failed: true }],
    dom: [{ severity: 'warning', category: 'a11y', message: 'button has no accessible name', evidence: { selector: 'button' }, confidence: 'high' }],
  };
  const findings = buildFindings(obs);
  assert.equal(findings[0].severity, 'error');
  assert.ok(findings.some((f) => f.category === 'a11y'));
});

test('narrate produces a readable causal line', () => {
  const findings = buildFindings({
    console: [{ level: 'error', message: 'TypeError x (/api/cart)', stack: '    at C (https://a/src/C.tsx:1:1)', timestamp: 5 }],
    network: [{ url: 'https://a/api/cart', status: 401, timestamp: 4, failed: true }],
    dom: [],
  });
  const text = narrate(findings);
  assert.match(text, /\[error\]/);
  assert.match(text, /↳ Network failure/);
  assert.match(text, /source: https:\/\/a\/src\/C\.tsx/);
});

test('narrate handles the clean case', () => {
  assert.match(narrate([]), /No errors/);
});
