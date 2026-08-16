#!/usr/bin/env node
/**
 * Runs the real extraction prompt against the real Gemini API, on real PDFs,
 * without deploying or touching Drive.
 *
 *   GEMINI_API_KEY=... node tools/try-extract.js invoice.pdf statement.pdf
 *
 * This is the one thing the test suite cannot prove: the suite fakes Gemini,
 * so it verifies logic but says nothing about whether the model reads your
 * actual documents correctly. This does the opposite - no Drive, no Gmail,
 * just prompt in, extraction out.
 *
 * It drives Code.js itself rather than reimplementing the call, so the request
 * is identical to what Apps Script sends: same prompt, same model, same
 * generation config, same fence-tolerant parser.
 *
 * Costs one Gemini call per file. Your key is read from the environment and
 * never written anywhere.
 */
const fs = require('fs');
const path = require('path');
const { load } = require('../test/harness.js');

const apiKey = process.env.GEMINI_API_KEY;
const files = process.argv.slice(2);

if (!apiKey) {
  console.error(`GEMINI_API_KEY is not set.

  GEMINI_API_KEY=<key> node tools/try-extract.js <file.pdf> [more.pdf ...]

It is the same key as the GEMINI_API_KEY Script Property. Pass it in the
environment so it is never written to disk.`);
  process.exit(1);
}
if (!files.length) {
  console.error('No PDFs given.\n\n  node tools/try-extract.js <file.pdf> [more.pdf ...]');
  process.exit(1);
}

/**
 * UrlFetchApp over the real network.
 *
 * Apps Script's UrlFetchApp is synchronous and Node has no synchronous HTTP,
 * so this shells out to curl. That keeps Code.js completely unmodified - it
 * cannot tell the difference.
 */
const { execFileSync } = require('child_process');

const realUrlFetch = {
  fetch(url, options) {
    const method = (options && options.method ? options.method : 'GET').toUpperCase();
    const args = ['-sS', '-X', method, url];

    if (options && options.headers) {
      for (const [key, value] of Object.entries(options.headers)) args.push('-H', `${key}: ${value}`);
    }
    if (options && options.payload) args.push('--data-binary', '@-');

    const body = execFileSync('curl', args, {
      input: options && options.payload ? options.payload : undefined,
      maxBuffer: 64 * 1024 * 1024
    }).toString();

    return { getContentText: () => body, getResponseCode: () => 200 };
  }
};

const { api } = load({
  urlFetch: realUrlFetch,
  properties: { GEMINI_API_KEY: apiKey }
});

console.log(`model: ${api.getConfig('GEMINI_MODEL')}\n`);

let failures = 0;
for (const file of files) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) {
    console.error(`  ${name}: not found`);
    failures++;
    continue;
  }

  const bytes = fs.readFileSync(file);
  const blob = {
    getBytes: () => bytes,
    getName: () => name,
    getContentType: () => 'application/pdf'
  };

  process.stdout.write(`${name}  (${(bytes.length / 1024).toFixed(0)} KB)  ... `);
  const started = Date.now();

  try {
    const result = api.analyzeDocument(blob);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${result.type}  [${elapsed}s]`);

    if (result.type === 'invoice') {
      console.log(`    vendor:  ${result.vendor}`);
      console.log(`    date:    ${result.date}`);
      console.log(`    total:   ${result.total} ${result.currency}`);
      console.log(`    number:  ${result.invoice_number}`);
      if (!api.monthOf(result.date)) console.log(`    WARNING: unusable date -> would go to _Unsorted`);
      if (!isFinite(result.total)) console.log(`    WARNING: no numeric total -> can never match a charge`);
    } else if (result.type === 'account_statement') {
      const period = result.period || {};
      console.log(`    period:  ${period.start} .. ${period.end}  -> files under ${api.monthOf(period.start)}`);
      const entries = result.entries || [];
      const debits = entries.filter(e => e.direction === 'debit').length;
      const credits = entries.filter(e => e.direction === 'credit').length;
      const unknown = entries.length - debits - credits;
      console.log(`    entries: ${entries.length}  (${debits} debit, ${credits} credit, ${unknown} unclassified)`);
      if (unknown) console.log(`    WARNING: ${unknown} entr(ies) would land in NEEDS REVIEW`);
      entries.slice(0, 5).forEach(e =>
        console.log(`      ${e.date}  ${String(e.description).slice(0, 38).padEnd(38)} ${String(e.amount).padStart(10)} ${e.currency || ''} ${e.direction || '??'}`));
      if (entries.length > 5) console.log(`      ... ${entries.length - 5} more`);
    } else {
      console.log(`    would move to _Unsorted`);
    }
  } catch (e) {
    console.log('FAILED');
    console.error(`    ${e.message}`);
    failures++;
  }
  console.log('');
}

process.exit(failures ? 1 : 0);
