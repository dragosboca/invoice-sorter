/**
 * Test suite for Code.js. Run with `npm test`.
 *
 * Code.js targets the Apps Script runtime, so it is loaded against in-memory
 * fakes (test/fakes.js) rather than real Drive/Gmail/Sheets. That covers logic
 * and control flow; it does NOT prove the real Google APIs behave as assumed.
 */
const { load, functionNames } = require('./harness.js');
const { fakeAttachment, fakeThread } = require('./fakes.js');

let failures = 0;
let checks = 0;
const covered = new Set();
const hit = name => covered.add(name);

function check(label, condition, detail) {
  checks++;
  if (condition) {
    console.log('  \x1b[32mPASS\x1b[0m  ' + label);
  } else {
    failures++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + label + (detail ? '\n          ' + detail : ''));
  }
}
const section = title => console.log('\n\x1b[1m' + title + '\x1b[0m');

/** Puts a fake PDF into a folder. The marker drives the Gemini stub. */
const putPdf = (folder, name, marker) =>
  folder.createFile(fakeAttachment(name, marker));

const folderNames = folder => {
  const out = [];
  const files = folder.getFiles();
  while (files.hasNext()) out.push(files.next().getName());
  return out;
};

const STATEMENT_AUG = 'STATEMENT|2026-08-01|2026-08-31|' +
  '2026-08-02,ACME,99.50,EUR,debit;' +      // matches a JULY invoice
  '2026-08-03,Mystery,31.00,EUR,debit;' +   // no invoice -> MISSING
  '2026-08-04,Refund,15.00,EUR,credit;' +   // credit -> ignored
  '2026-08-05,Weird,9.00,EUR,';             // no direction -> NEEDS REVIEW

/** Builds a populated staging folder and triages it. */
function seedAndTriage() {
  const ctx = load({ onHit: hit });
  const root = ctx.api.getRootFolder();
  const staging = root.createFolder('_Staging');

  putPdf(staging, 'acme.pdf', 'INVOICE|ACME|2026-07-28|99.50|EUR');
  putPdf(staging, 'globex.pdf', 'INVOICE|Globex|2026-07-05|20.00|EUR');
  putPdf(staging, 'unbilled.pdf', 'INVOICE|Initech|2026-07-20|88.00|EUR');
  putPdf(staging, 'junk.pdf', 'SOMETHING ELSE');
  putPdf(staging, 'stmt.pdf', STATEMENT_AUG);
  putPdf(staging, 'stmt-jul.pdf', 'STATEMENT|2026-07-01|2026-07-31|2026-07-05,Globex,20.00,EUR,debit;');

  ctx.api.triageStaging();
  return { ctx, root, staging };
}

// ---------------------------------------------------------------- matching --
section('Matching core');
{
  const { api } = load({ onHit: hit });

  let r = api.matchEntriesToInvoices(
    [{ date: '2026-08-02', description: 'ACME', amount: 99.5, currency: 'EUR', direction: 'debit', sourceFile: 's', month: '2026-08', key: 'e' }],
    [{ fileName: 'a.pdf', vendor: 'ACME', date: '2026-07-28', total: 99.5, currency: 'EUR', key: 'i' }]);
  check('July invoice matches an August charge (cross-month)', r.matched.length === 1);

  r = api.matchEntriesToInvoices(
    [{ date: '2026-07-10', amount: 10, currency: 'EUR', direction: 'debit', key: 'a' }],
    [{ fileName: 'far.pdf', date: '2026-07-02', total: 10, currency: 'EUR' },
     { fileName: 'near.pdf', date: '2026-07-09', total: 10, currency: 'EUR' }]);
  check('closest invoice date wins', r.matched[0].invoice.fileName === 'near.pdf');

  r = api.matchEntriesToInvoices(
    [{ date: '2026-07-10', amount: 9.99, currency: 'EUR', direction: 'debit', key: 'a' },
     { date: '2026-07-11', amount: 9.99, currency: 'EUR', direction: 'debit', key: 'b' }],
    [{ fileName: 'sub.pdf', date: '2026-07-10', total: 9.99, currency: 'EUR' }]);
  check('one invoice satisfies at most one charge', r.matched.length === 1 && r.missing.length === 1);

  r = api.matchEntriesToInvoices(
    [{ date: '2026-07-30', amount: 5, currency: 'EUR', direction: 'debit', key: 'a' }],
    [{ fileName: 'old.pdf', date: '2026-07-01', total: 5, currency: 'EUR' }]);
  check('outside the date window is missing, not matched', r.missing.length === 1);

  r = api.matchEntriesToInvoices(
    [{ date: '2026-07-10', amount: 50, currency: 'USD', direction: 'debit', key: 'a' }],
    [{ fileName: 'x.pdf', date: '2026-07-09', total: 50, currency: 'EUR' }]);
  check('currency mismatch is missing, not matched', r.missing.length === 1);

  // Regression: NaN > tolerance is false, so a totalless invoice used to slip
  // past the amount guard and match an arbitrary charge.
  r = api.matchEntriesToInvoices(
    [{ date: '2026-07-10', amount: 77, currency: 'EUR', direction: 'debit', key: 'a' }],
    [{ fileName: 'notot.pdf', date: '2026-07-10', currency: 'EUR' }]);
  check('invoice with no total cannot match (NaN guard)', r.matched.length === 0 && r.missing.length === 1);

  // Regression: `direction !== 'debit'` silently bucketed unknowns as credits.
  r = api.matchEntriesToInvoices(
    [{ date: '2026-07-10', amount: 5, currency: 'EUR', direction: undefined, key: 'u' }], []);
  check('unknown direction is surfaced, never silently dropped', r.unclassified.length === 1);
}

// ------------------------------------------------------------------ triage --
section('Triage: classification and filing');
{
  const { ctx, root, staging } = seedAndTriage();

  check('staging is drained', !staging.getFiles().hasNext());
  check('non-document moved to _Unsorted',
    root.getFoldersByName('_Unsorted').next().getFiles().hasNext());

  const year = root.getFoldersByName('2026').next();
  const july = year.getFoldersByName('07').next();
  const august = year.getFoldersByName('08').next();

  check('invoice filed under its invoice month', folderNames(july).includes('[2026-07] acme.pdf'));
  check('statement filed by PERIOD, not arrival date',
    folderNames(august).includes('[2026-08] stmt.pdf'), folderNames(august).join(', '));
  check('exactly one Gemini call per document', ctx.state.geminiCalls === 6,
    'made ' + ctx.state.geminiCalls);
}

// ------------------------------------------------------------------ ledger --
section('Ledger records');
{
  const { ctx, root } = seedAndTriage();
  const ledger = ctx.api.getLedgerSpreadsheet(root);
  const records = ctx.api.readDataRecords(ledger);
  const kind = k => records.filter(r => r.kind === k);

  check('3 invoice records', kind('invoice').length === 3);
  check('2 statement_file records', kind('statement_file').length === 2);
  check('5 statement_entry records', kind('statement_entry').length === 5);
  check('1 unsorted record', kind('unsorted').length === 1);
  check('write/read round-trip preserves amounts',
    kind('invoice').some(r => Number(r.amount) === 99.5));
  check('write/read round-trip preserves currency',
    kind('invoice').every(r => r.currency === 'EUR'));
}

// -------------------------------------------------------------------- views --
section('Rebuild: global matching and month views');
{
  const { ctx, root } = seedAndTriage();
  const ledger = ctx.api.getLedgerSpreadsheet(root);

  const before = ctx.state.geminiCalls;
  ctx.api.rebuildLedger();
  check('rebuild makes zero API calls', ctx.state.geminiCalls === before);

  const view = ctx.api.VIEW_HEADER;
  const augustTab = ledger.getSheetByName('2026-08');
  const rows = augustTab.getRange(2, 1, augustTab.getLastRow() - 1, view.length).getValues();
  const withStatus = s => rows.filter(r => r[0] === s);

  check('cross-month charge shows as MATCHED with its July invoice',
    withStatus('MATCHED').some(r => String(r[view.indexOf('Invoice File')]).includes('acme')));
  check('charge with no invoice -> MISSING INVOICE', withStatus('MISSING INVOICE').length === 1);
  check('directionless entry -> NEEDS REVIEW', withStatus('NEEDS REVIEW').length === 1);
  check('credit is not reported as missing',
    !rows.some(r => String(r[view.indexOf('Statement Description')]) === 'Refund'));
  check('problems sort above MATCHED', rows[0][0] !== 'MATCHED', 'first row: ' + rows[0][0]);

  const julyTab = ledger.getSheetByName('2026-07');
  const julyRows = julyTab.getRange(2, 1, julyTab.getLastRow() - 1, view.length).getValues();
  check('uncharged invoice -> NO STATEMENT ENTRY',
    julyRows.some(r => r[0] === 'NO STATEMENT ENTRY' &&
      String(r[view.indexOf('Invoice File')]).includes('unbilled')));
  check('every row carries a stable key',
    rows.every(r => !!r[view.indexOf('Key')]));
}

section('Hand-written notes survive a rebuild');
{
  const { ctx, root } = seedAndTriage();
  const ledger = ctx.api.getLedgerSpreadsheet(root);
  ctx.api.rebuildLedger();

  const view = ctx.api.VIEW_HEADER;
  const tab = ledger.getSheetByName('2026-08');
  tab.getRange(2, view.indexOf('Notes') + 1, 1, 1).setValues([['checked with bank']]);
  const key = tab.getRange(2, view.indexOf('Key') + 1, 1, 1).getValues()[0][0];

  ctx.api.rebuildLedger();

  const after = tab.getRange(2, 1, tab.getLastRow() - 1, view.length).getValues();
  const row = after.find(r => r[view.indexOf('Key')] === key);
  check('note preserved across rebuild',
    !!row && row[view.indexOf('Notes')] === 'checked with bank',
    row ? JSON.stringify(row) : 'row disappeared');
}

section('CSV snapshots');
{
  const { ctx, root } = seedAndTriage();
  ctx.api.rebuildLedger();

  const july = root.getFoldersByName('2026').next().getFoldersByName('07').next();
  check('CSV written into the month folder',
    july.getFilesByName('reconciliation-2026-07.csv').hasNext());

  const text = july.getFilesByName('reconciliation-2026-07.csv').next().getContentText();
  check('CSV starts with the header row', text.split('\n')[0].startsWith('Status,'));

  ctx.api.rebuildLedger();
  let count = 0;
  const again = july.getFilesByName('reconciliation-2026-07.csv');
  while (again.hasNext()) { again.next(); count++; }
  check('CSV overwritten in place, not duplicated', count === 1, 'found ' + count);

  check('CSV escapes commas', ctx.api.toCsvCell('a,b') === '"a,b"');
  check('CSV escapes quotes', ctx.api.toCsvCell('say "hi"') === '"say ""hi"""');
  check('CSV leaves plain values alone', ctx.api.toCsvCell('plain') === 'plain');
}

// ------------------------------------------------------------------- gmail --
section('Fetch from Gmail into staging');
{
  const threads = [fakeThread([
    fakeAttachment('inv.pdf', 'INVOICE|ACME|2026-07-01|10.00|EUR'),
    fakeAttachment('notes.txt', 'hello', 'text/plain'),
    fakeAttachment('odd.pdf', 'INVOICE|Odd|2026-07-02|11.00|EUR', 'application/octet-stream')
  ])];

  const ctx = load({ onHit: hit, gmailThreads: threads });
  ctx.api.fetchToStaging();

  const root = ctx.api.getRootFolder();
  const staged = folderNames(root.getFoldersByName('_Staging').next());

  check('PDF attachment staged', staged.includes('inv.pdf'));
  check('non-PDF attachment skipped', !staged.includes('notes.txt'));
  check('PDF mislabelled as octet-stream still staged', staged.includes('odd.pdf'));
  check('thread labelled as processed', threads[0].labels.length === 1);
  check('no Gemini calls during fetch', ctx.state.geminiCalls === 0);
}

section('Deduplication (the duplicate-filing hazard)');
{
  const attachment = fakeAttachment('inv.pdf', 'INVOICE|ACME|2026-07-01|10.00|EUR');
  const ctx = load({ onHit: hit, gmailThreads: [fakeThread([attachment])] });
  const root = ctx.api.getRootFolder();

  ctx.api.fetchToStaging();
  ctx.api.triageStaging();

  // Same attachment offered again: it is filed and recorded, so it must not
  // come back through staging and be filed a second time.
  ctx.api.fetchToStaging();
  const staging = root.getFoldersByName('_Staging').next();
  check('already-filed attachment is not re-staged', folderNames(staging).length === 0,
    folderNames(staging).join(', '));

  const july = root.getFoldersByName('2026').next().getFoldersByName('07').next();
  check('no duplicate copy filed', folderNames(july).filter(n => n.includes('inv.pdf')).length === 1);

  const hashes = ctx.api.getKnownHashes(root, staging);
  check('known-hash index is populated', hashes.size >= 1);
}

section('indexExistingFiles migration');
{
  const ctx = load({ onHit: hit });
  const root = ctx.api.getRootFolder();
  const july = root.createFolder('2026').createFolder('07');
  putPdf(july, '[2026-07] legacy.pdf', 'INVOICE|Legacy|2026-07-01|5.00|EUR');

  ctx.api.indexExistingFiles();
  const ledger = ctx.api.getLedgerSpreadsheet(root);
  const first = ctx.api.readDataRecords(ledger).length;

  check('legacy file indexed', first === 1);
  check('no Gemini calls during indexing', ctx.state.geminiCalls === 0);

  ctx.api.indexExistingFiles();
  check('re-running adds nothing (idempotent)',
    ctx.api.readDataRecords(ledger).length === first);

  ctx.api.rebuildLedger();
  check('indexed records are inert to matching', ctx.state.geminiCalls === 0);
}

section('Full pipeline');
{
  const threads = [fakeThread([fakeAttachment('inv.pdf', 'INVOICE|ACME|2026-07-01|10.00|EUR')])];
  const ctx = load({ onHit: hit, gmailThreads: threads });

  ctx.api.processInvoices();

  const root = ctx.api.getRootFolder();
  const july = root.getFoldersByName('2026').next().getFoldersByName('07').next();
  check('end to end: Gmail -> staging -> filed', folderNames(july).includes('[2026-07] inv.pdf'));
  check('ledger populated by the pipeline',
    ctx.api.readDataRecords(ctx.api.getLedgerSpreadsheet(root)).length >= 1);
}

// ------------------------------------------------------------------ helpers --
section('Helpers');
{
  const { api } = load({ onHit: hit });

  // String-based on purpose: building a Date shifts across timezones and
  // misfiles anything dated the 1st or the last of a month.
  check('month of the 1st does not slip back', api.monthOf('2026-07-01') === '2026-07');
  check('month of the 31st does not slip forward', api.monthOf('2026-07-31') === '2026-07');
  check('month of Dec 31 stays in December', api.monthOf('2026-12-31') === '2026-12');
  check('month of a null date is null', api.monthOf(null) === null);
  check('month of garbage is null', api.monthOf('not a date') === null);

  check('parses fenced JSON', api.parseGeminiJson('```json\n{"a":1}\n```').a === 1);
  check('parses bare JSON', api.parseGeminiJson('{"a":2}').a === 2);

  check('page count read from /Count',
    api.getPdfPageCount({ getBytes: () => Buffer.from('x /Count 7 x') }) === 7);
  check('page count falls back to 1',
    api.getPdfPageCount({ getBytes: () => Buffer.from('nothing') }) === 1);

  check('month prefix stripped', api.stripMonthPrefix('[2026-07] a.pdf') === 'a.pdf');
  check('re-filing does not double the prefix',
    api.stripMonthPrefix(api.stripMonthPrefix('[2026-07] a.pdf')) === 'a.pdf');

  check('entry keys are stable',
    api.entryKey('s', { date: 'd', description: 'x', amount: 1, currency: 'E' }) ===
    api.entryKey('s', { date: 'd', description: 'x', amount: 1, currency: 'E' }));
  check('entry keys differ on amount',
    api.entryKey('s', { date: 'd', description: 'x', amount: 1, currency: 'E' }) !==
    api.entryKey('s', { date: 'd', description: 'x', amount: 2, currency: 'E' }));

  check('dateOf prefers the statement date',
    api.dateOf({ entry: { date: '2026-07-01' }, invoice: { date: '2026-07-09' } }) === '2026-07-01');
  check('dateOf falls back to the invoice date',
    api.dateOf({ entry: null, invoice: { date: '2026-07-09' } }) === '2026-07-09');
  check('dateOf tolerates neither', api.dateOf({ entry: null, invoice: null }) === '');

  check('blank amount is NaN, not zero', isNaN(api.toNumber('')));
  check('numeric strings convert', api.toNumber('12.5') === 12.5);
}

// ---------------------------------------------------------------- coverage --
const all = functionNames();
const missed = all.filter(name => !covered.has(name));

console.log('\n' + '-'.repeat(64));
console.log(`${checks - failures}/${checks} checks passed`);
console.log(`coverage: ${all.length - missed.length}/${all.length} functions executed`);
if (missed.length) console.log('not executed: ' + missed.join(', '));
console.log('-'.repeat(64));

process.exit(failures ? 1 : 0);
