#!/usr/bin/env node
// observe.js — one-stop semantic web observation.
//
//   web-observe <url> [--json] [--settle <ms>] [--timeout <ms>]
//
// Navigates the URL, collects raw browser state (console, network, a11y, DOM),
// runs the causal normalizer, and emits either a human/AI-readable narrative
// (default) or the full structured WebDevObservation JSON (--json).
//
// Exit 0 if no error-severity findings, 1 if any error-severity finding, 2 on
// usage/collection failure — so it gates like a test in an iterate-until-clean
// loop.

'use strict';

const { collect } = require('./collect.js');
const { buildFindings, narrate } = require('./correlate.js');

async function main(argv) {
  let url = null, json = false, settleMs = 0, timeout = 30000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--settle') settleMs = parseInt(argv[++i], 10);
    else if (a === '--timeout') timeout = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') { usage(); return 0; }
    else if (a.startsWith('--')) { process.stderr.write(`unknown option: ${a}\n`); return 2; }
    else url = a;
  }
  if (!url) { usage(); return 2; }
  if (settleMs != null && Number.isNaN(settleMs)) { process.stderr.write('--settle needs a number\n'); return 2; }

  let obs;
  try {
    obs = await collect(url, { settleMs, timeout });
  } catch (e) {
    process.stderr.write(`collection failed: ${e.message}\n`);
    return 2;
  }

  const findings = buildFindings(obs);
  const hasError = findings.some((f) => f.severity === 'error');

  if (json) {
    process.stdout.write(JSON.stringify({
      url: obs.url,
      finalUrl: obs.finalUrl,
      pass: !hasError,
      findings,
      counts: {
        consoleErrors: obs.console.filter((c) => c.level === 'error').length,
        networkFailures: obs.network.length,
        domFindings: obs.dom.length,
      },
      accessibility: obs.accessibility,
      raw: { console: obs.console, network: obs.network, dom: obs.dom },
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`${hasError ? 'FAIL' : 'OK'}  ${obs.finalUrl}\n`);
    process.stdout.write(narrate(findings) + '\n');
  }
  return hasError ? 1 : 0;
}

function usage() {
  process.stderr.write('usage: web-observe <url> [--json] [--settle <ms>] [--timeout <ms>]\n');
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => {
    process.stderr.write(`error: ${e.stack || e.message}\n`); process.exit(2);
  });
}

module.exports = { main };
