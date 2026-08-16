/**
 * Google Apps Script to automate invoice sorting and statement reconciliation.
 *
 * Pipeline (run `processInvoices` on a monthly trigger):
 *
 *   Gmail ──▶ _Staging ──▶ YYYY/MM/          ──▶ Reconciliation Ledger
 *            (fetch)      (triage)               (rebuild)
 *
 * Every PDF - invoice or account statement, emailed or dropped in by hand -
 * lands in one staging folder, gets classified by Gemini exactly once, and is
 * filed by date. Invoices file by invoice date; statements file by the period
 * they cover, so a July statement emailed on August 1st still sits with the
 * July invoices it reconciles.
 *
 * The ledger is a Google Sheet holding every statement entry and every invoice
 * ever seen. Matching runs across the whole ledger rather than per folder, so a
 * July invoice charged on the August statement matches correctly. Per-month
 * tabs and CSV snapshots are views of that global result.
 *
 * Requires a Gemini API key from https://aistudio.google.com/app/apikey,
 * stored as the GEMINI_API_KEY Script Property.
 */

// Hash cache to avoid recomputing hashes for the same files
const HASH_CACHE = {};

// Default Configuration (can be overridden via Script Properties)
const DEFAULTS = {
  GMAIL_SEARCH_QUERY: 'from:-me has:attachment newer_than:35d',
  ROOT_FOLDER_NAME: 'Invoices',
  STAGING_FOLDER_NAME: '_Staging',
  UNSORTED_FOLDER_NAME: '_Unsorted',
  LEDGER_NAME: 'Reconciliation Ledger',
  PROCESSED_LABEL: 'Processed-Invoice',
  GEMINI_MODEL: 'gemini-3-pro-preview',
  // A sanity cap only. Statements run long, and a document's type is unknown
  // until it has been classified, so this must not be tight enough to reject
  // a statement before it is even looked at.
  MAX_PDF_PAGES: 50,
  TEMPERATURE: 0.1,
  MAX_OUTPUT_TOKENS: 2048,
  MAX_RETRIES: 5,
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 30000,
  EXTRACTION_MAX_OUTPUT_TOKENS: 8192,
  MATCH_DATE_WINDOW_DAYS: 14,
  MATCH_AMOUNT_TOLERANCE: 0.01,
  WRITE_MONTH_CSV: true
};

// Column order of the ledger's raw-record tab. Append only - existing sheets
// are read by this order.
const DATA_HEADER = ['kind', 'key', 'fileName', 'contentHash', 'month', 'date',
  'party', 'amount', 'currency', 'direction', 'sourceFile', 'reference'];

const DATA_SHEET_NAME = '_Data';

const VIEW_HEADER = ['Status', 'Statement Date', 'Statement Description', 'Amount',
  'Currency', 'Invoice Vendor', 'Invoice Date', 'Invoice File', 'Notes', 'Key'];

/**
 * Gets configuration value from Script Properties with fallback to defaults.
 */
function getConfig(key) {
  const properties = PropertiesService.getScriptProperties();
  const value = properties.getProperty(key);

  if (value !== null) {
    // Try to parse as number if it looks like a number
    if (!isNaN(value) && value.trim() !== '') {
      return Number(value);
    }
    // Return null for empty string or "null" string
    if (value === '' || value.toLowerCase() === 'null') {
      return null;
    }
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    return value;
  }

  return DEFAULTS[key];
}

/**
 * Gets the Gemini API key from Script Properties.
 */
function getGeminiApiKey() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('Gemini API key not configured. Please add GEMINI_API_KEY to Script Properties.');
  }
  return apiKey;
}

/**
 * Main entry point - run this on a monthly trigger.
 *
 * The three phases are separately runnable for debugging, and the pipeline is
 * resumable: triage moves each file out of staging as it finishes, so a run
 * that hits the Apps Script execution limit picks up where it left off.
 */
function processInvoices() {
  fetchToStaging();
  triageStaging();
  rebuildLedger();
}

/**
 * Phase 1: copy PDF attachments from matching Gmail threads into staging.
 */
function fetchToStaging() {
  const searchQuery = getConfig('GMAIL_SEARCH_QUERY');
  const threads = GmailApp.search(searchQuery);
  console.log(`Found ${threads.length} threads matching query.`);
  if (threads.length === 0) return;

  const root = getRootFolder();
  const staging = getOrCreateSubFolder(root, getConfig('STAGING_FOLDER_NAME'));

  // Hashes of everything already filed, read once from the ledger rather than
  // by walking every month folder in Drive.
  const known = getKnownHashes(root, staging);

  for (const thread of threads) {
    let savedAny = false;

    for (const message of thread.getMessages()) {
      for (const attachment of message.getAttachments()) {
        const fileName = attachment.getName();
        if (!isPdfAttachment(attachment)) {
          console.log(`Skipping non-PDF: ${fileName}`);
          continue;
        }

        const hash = getFileHash(attachment);
        if (known.has(hash)) {
          console.log(`Already seen: ${fileName}`);
          savedAny = true;
          continue;
        }

        staging.createFile(attachment);
        known.add(hash);
        savedAny = true;
        console.log(`Staged: ${fileName}`);
      }
    }

    const processedLabel = getConfig('PROCESSED_LABEL');
    if (processedLabel && savedAny) {
      thread.addLabel(getOrCreateLabel(processedLabel));
    }
  }
}

/**
 * Phase 2: classify each staged PDF and file it.
 *
 * Invoices and statements move to their month folder; anything else moves to
 * the unsorted folder so staging stays a true queue and a rejected file is
 * never sent to Gemini twice.
 */
function triageStaging() {
  const root = getRootFolder();
  const staging = getOrCreateSubFolder(root, getConfig('STAGING_FOLDER_NAME'));
  const ledger = getLedgerSpreadsheet(root);

  const records = [];
  const files = staging.getFiles();
  let processed = 0;

  while (files.hasNext()) {
    const file = files.next();
    const fileName = file.getName();

    if (!isPdfFile(file)) {
      console.log(`Not a PDF, moving to unsorted: ${fileName}`);
      moveToUnsorted(root, file);
      continue;
    }

    try {
      const pages = getPdfPageCount(file.getBlob());
      const maxPages = getConfig('MAX_PDF_PAGES');
      if (pages > maxPages) {
        console.log(`Too many pages (${pages} > ${maxPages}), moving to unsorted: ${fileName}`);
        records.push(unsortedRecord(file, `${pages} pages`));
        moveToUnsorted(root, file);
        continue;
      }

      const analysis = analyzeDocument(file.getBlob());
      const contentHash = getFileHash(file);

      if (analysis.type === 'invoice') {
        fileInvoice(root, file, analysis, contentHash, records);
      } else if (analysis.type === 'account_statement') {
        fileStatement(root, file, analysis, contentHash, records);
      } else {
        console.log(`Neither invoice nor statement, moving to unsorted: ${fileName}`);
        records.push(unsortedRecord(file, 'not an invoice or statement'));
        moveToUnsorted(root, file);
      }
      processed++;

    } catch (e) {
      // Leave it in staging: an API error is transient, and moving it would
      // quietly bury a document that should have been filed.
      console.error(`Error triaging ${fileName}, leaving in staging: ${e.toString()}`);
    }
  }

  if (records.length) appendDataRecords(ledger, records);
  console.log(`Triaged ${processed} document(s).`);
}

/**
 * Files an invoice into YYYY/MM by its invoice date.
 */
function fileInvoice(root, file, analysis, contentHash, records) {
  const month = monthOf(analysis.date);
  if (!month) {
    console.warn(`No usable invoice date, moving to unsorted: ${file.getName()}`);
    records.push(unsortedRecord(file, 'no invoice date'));
    moveToUnsorted(root, file);
    return;
  }

  const targetName = `[${month}] ${stripMonthPrefix(file.getName())}`;
  moveToMonthFolder(root, file, month, targetName);

  records.push({
    kind: 'invoice',
    key: contentHash,
    fileName: targetName,
    contentHash: contentHash,
    month: month,
    date: analysis.date,
    party: analysis.vendor || '',
    amount: analysis.total,
    currency: analysis.currency || '',
    direction: '',
    sourceFile: '',
    reference: analysis.invoice_number || ''
  });

  console.log(`Invoice -> ${month}: ${targetName} (${analysis.total} ${analysis.currency})`);
}

/**
 * Files a statement into YYYY/MM by the period it covers, and records every
 * transaction line as its own ledger row.
 */
function fileStatement(root, file, analysis, contentHash, records) {
  // Period start is the label: a cycle running 15 Jul - 14 Aug belongs to July.
  const period = analysis.period || {};
  const month = monthOf(period.start) || monthOf(period.end) || monthOf(analysis.date);
  if (!month) {
    console.warn(`No usable statement period, moving to unsorted: ${file.getName()}`);
    records.push(unsortedRecord(file, 'no statement period'));
    moveToUnsorted(root, file);
    return;
  }

  const targetName = `[${month}] ${stripMonthPrefix(file.getName())}`;
  moveToMonthFolder(root, file, month, targetName);

  records.push({
    kind: 'statement_file',
    key: contentHash,
    fileName: targetName,
    contentHash: contentHash,
    month: month,
    date: period.start || '',
    party: '',
    amount: '',
    currency: '',
    direction: '',
    sourceFile: '',
    reference: period.end || ''
  });

  const entries = analysis.entries || [];
  for (const entry of entries) {
    records.push({
      kind: 'statement_entry',
      key: entryKey(targetName, entry),
      fileName: '',
      contentHash: '',
      month: monthOf(entry.date) || month,
      date: entry.date || '',
      party: entry.description || '',
      amount: entry.amount,
      currency: entry.currency || '',
      direction: entry.direction || '',
      sourceFile: targetName,
      reference: ''
    });
  }

  console.log(`Statement -> ${month}: ${targetName} (${entries.length} entries)`);
}

/**
 * Phase 3: match the whole ledger and rewrite the per-month views.
 *
 * Matching is global rather than per-month, so an invoice dated near a month
 * boundary still matches a charge that posted in the next statement period.
 */
function rebuildLedger() {
  const root = getRootFolder();
  const ledger = getLedgerSpreadsheet(root);
  const records = readDataRecords(ledger);

  const invoices = records.filter(r => r.kind === 'invoice').map(r => ({
    fileName: r.fileName,
    vendor: r.party,
    date: r.date,
    total: toNumber(r.amount),
    currency: r.currency,
    key: r.key
  }));

  const statementEntries = records.filter(r => r.kind === 'statement_entry').map(r => ({
    date: r.date,
    description: r.party,
    amount: toNumber(r.amount),
    currency: r.currency,
    direction: r.direction,
    sourceFile: r.sourceFile,
    month: r.month,
    key: r.key
  }));

  const result = matchEntriesToInvoices(statementEntries, invoices);
  const rows = buildLedgerRows(result);
  writeMonthViews(ledger, root, rows);

  console.log(`Ledger rebuilt: ${result.matched.length} matched, ` +
    `${result.missing.length} missing invoice(s), ` +
    `${result.unmatchedInvoices.length} invoice(s) not yet on a statement, ` +
    `${result.unclassified.length} needing review.`);
}

/**
 * Turns a match result into flat view rows, grouped later by month.
 */
function buildLedgerRows(result) {
  const rows = [];

  for (const m of result.matched) {
    rows.push({
      month: m.entry.month,
      status: 'MATCHED',
      entry: m.entry,
      invoice: m.invoice,
      key: m.entry.key
    });
  }

  for (const entry of result.missing) {
    rows.push({
      month: entry.month,
      status: 'MISSING INVOICE',
      entry: entry,
      invoice: null,
      key: entry.key
    });
  }

  for (const entry of result.unclassified) {
    rows.push({
      month: entry.month,
      status: 'NEEDS REVIEW',
      entry: entry,
      invoice: null,
      key: entry.key
    });
  }

  // Invoices with no charge yet - either not billed, or the statement covering
  // them has not arrived. Grouped by the invoice's own month.
  for (const invoice of result.unmatchedInvoices) {
    rows.push({
      month: monthOf(invoice.date) || '',
      status: 'NO STATEMENT ENTRY',
      entry: null,
      invoice: invoice,
      key: invoice.key
    });
  }

  return rows;
}

/**
 * Writes one tab per month into the ledger, plus an optional CSV snapshot into
 * each month folder. Manual notes are keyed by row and preserved across runs.
 */
function writeMonthViews(ledger, root, rows) {
  const byMonth = {};
  for (const row of rows) {
    const month = row.month || 'unknown';
    (byMonth[month] = byMonth[month] || []).push(row);
  }

  const statusOrder = { 'MISSING INVOICE': 0, 'NEEDS REVIEW': 1, 'NO STATEMENT ENTRY': 2, 'MATCHED': 3 };

  for (const month of Object.keys(byMonth).sort()) {
    const monthRows = byMonth[month].sort((a, b) => {
      const byStatus = statusOrder[a.status] - statusOrder[b.status];
      if (byStatus !== 0) return byStatus;
      return String(dateOf(a)).localeCompare(String(dateOf(b)));
    });

    const sheet = getOrCreateSheet(ledger, month);
    const notes = readExistingNotes(sheet);

    const values = [VIEW_HEADER].concat(monthRows.map(row => [
      row.status,
      row.entry ? row.entry.date : '',
      row.entry ? row.entry.description : '',
      row.entry ? row.entry.amount : (row.invoice ? row.invoice.total : ''),
      row.entry ? row.entry.currency : (row.invoice ? row.invoice.currency : ''),
      row.invoice ? row.invoice.vendor : '',
      row.invoice ? row.invoice.date : '',
      row.invoice ? row.invoice.fileName : '',
      notes[row.key] || '',
      row.key
    ]));

    sheet.clear();
    sheet.getRange(1, 1, values.length, VIEW_HEADER.length).setValues(values);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, VIEW_HEADER.length).setFontWeight('bold');

    if (getConfig('WRITE_MONTH_CSV')) {
      writeMonthCsv(root, month, values);
    }
  }
}

/**
 * Writes a derived CSV snapshot into the month's folder. Overwrites in place.
 */
function writeMonthCsv(root, month, values) {
  if (!/^\d{4}-\d{2}$/.test(month)) return;

  const yearFolder = getOrCreateSubFolder(root, month.slice(0, 4));
  const monthFolder = getOrCreateSubFolder(yearFolder, month.slice(5, 7));
  const csvName = `reconciliation-${month}.csv`;
  const csv = values.map(row => row.map(toCsvCell).join(',')).join('\n');

  const existing = monthFolder.getFilesByName(csvName);
  if (existing.hasNext()) {
    existing.next().setContent(csv);
  } else {
    monthFolder.createFile(csvName, csv, 'text/csv');
  }
}

function toCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function dateOf(row) {
  if (row.entry && row.entry.date) return row.entry.date;
  if (row.invoice && row.invoice.date) return row.invoice.date;
  return '';
}

/**
 * Reads the Notes column of an existing view tab, keyed by row key, so a
 * rebuild does not discard anything typed in by hand.
 */
function readExistingNotes(sheet) {
  const notes = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return notes;

  const noteIndex = VIEW_HEADER.indexOf('Notes');
  const keyIndex = VIEW_HEADER.indexOf('Key');
  const values = sheet.getRange(2, 1, lastRow - 1, VIEW_HEADER.length).getValues();

  for (const row of values) {
    const key = row[keyIndex];
    const note = row[noteIndex];
    if (key && note) notes[key] = note;
  }

  return notes;
}

/**
 * Classifies a PDF and extracts its data in a single Gemini call.
 */
function analyzeDocument(pdfBlob) {
  const prompt = `Analyze this PDF document and classify it as an account/bank/credit-card statement, an invoice, or something else.
The document can be written in any language.

Respond with ONLY a JSON object (no markdown fences, no commentary) in one of these shapes:

If it is an account statement, extract the period it covers and EVERY transaction line:
{"type": "account_statement", "period": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}, "entries": [{"date": "YYYY-MM-DD", "description": "counterparty or transaction description", "amount": 123.45, "currency": "EUR", "direction": "debit"}]}
- "period" is the statement period covered by the document, NOT the date it was printed or sent.
- "amount" is always a positive number.
- "direction" is "debit" for money leaving the account (payments/charges) and "credit" for money coming in. Always set it explicitly.

If it is an invoice or billing document:
{"type": "invoice", "vendor": "issuer name", "invoice_number": "or null", "date": "YYYY-MM-DD", "total": 123.45, "currency": "EUR"}
- "total" is the final amount due (including tax), as a positive number.
- "date" is the invoice/issue date, NOT the due date or service period.

Otherwise:
{"type": "other"}`;

  const response = callGeminiWithPdf(prompt, pdfBlob, getConfig('EXTRACTION_MAX_OUTPUT_TOKENS'));
  return parseGeminiJson(response);
}

/**
 * Parses a JSON response from Gemini, tolerating markdown code fences.
 */
function parseGeminiJson(text) {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  return JSON.parse(cleaned);
}

/**
 * Matches statement debit entries to invoices by amount, currency and date
 * proximity. Each invoice is used at most once; the closest date within the
 * window wins.
 */
function matchEntriesToInvoices(statementEntries, invoices) {
  const dateWindowMs = getConfig('MATCH_DATE_WINDOW_DAYS') * 24 * 60 * 60 * 1000;
  const tolerance = getConfig('MATCH_AMOUNT_TOLERANCE');

  // Only an explicit "credit" is treated as incoming money. Anything else - a
  // missing or unrecognised direction - is reported rather than silently
  // dropped, since quietly ignoring a charge is the one failure this tool
  // must not have.
  const debits = statementEntries.filter(entry => entry.direction === 'debit');
  const credits = statementEntries.filter(entry => entry.direction === 'credit');
  const unclassified = statementEntries.filter(entry =>
    entry.direction !== 'debit' && entry.direction !== 'credit');

  const usedInvoices = new Set();
  const matched = [];
  const missing = [];

  for (const entry of debits) {
    const entryDate = new Date(entry.date);
    let bestInvoice = null;
    let bestDistance = Infinity;

    for (const invoice of invoices) {
      if (usedInvoices.has(invoice.fileName)) continue;

      // Both amounts must be real numbers before comparing: NaN > tolerance is
      // false, so a totalless invoice would otherwise pass this guard and match
      // an arbitrary charge.
      if (!isFinite(invoice.total) || !isFinite(entry.amount)) continue;
      if (Math.abs(invoice.total - entry.amount) > tolerance) continue;

      if (invoice.currency && entry.currency &&
        invoice.currency.toUpperCase() !== entry.currency.toUpperCase()) continue;

      const invoiceDate = new Date(invoice.date);
      const distance = Math.abs(invoiceDate - entryDate);
      if (isNaN(distance) || distance > dateWindowMs) continue;

      if (distance < bestDistance) {
        bestDistance = distance;
        bestInvoice = invoice;
      }
    }

    if (bestInvoice) {
      usedInvoices.add(bestInvoice.fileName);
      matched.push({ entry: entry, invoice: bestInvoice });
    } else {
      missing.push(entry);
    }
  }

  const unmatchedInvoices = invoices.filter(invoice => !usedInvoices.has(invoice.fileName));

  return { matched, missing, unmatchedInvoices, ignoredCredits: credits, unclassified };
}

/**
 * Ledger storage - the spreadsheet is both the human view and the record of
 * what has already been extracted, so nothing is sent to Gemini twice.
 */
function getLedgerSpreadsheet(root) {
  const name = getConfig('LEDGER_NAME');
  const existing = root.getFilesByName(name);

  if (existing.hasNext()) {
    return SpreadsheetApp.open(existing.next());
  }

  const spreadsheet = SpreadsheetApp.create(name);
  DriveApp.getFileById(spreadsheet.getId()).moveTo(root);

  const data = spreadsheet.getSheets()[0];
  data.setName(DATA_SHEET_NAME);
  data.getRange(1, 1, 1, DATA_HEADER.length).setValues([DATA_HEADER]).setFontWeight('bold');
  data.setFrozenRows(1);

  console.log(`Created ledger: ${name}`);
  return spreadsheet;
}

function getDataSheet(ledger) {
  const sheet = ledger.getSheetByName(DATA_SHEET_NAME);
  if (sheet) return sheet;

  const created = ledger.insertSheet(DATA_SHEET_NAME);
  created.getRange(1, 1, 1, DATA_HEADER.length).setValues([DATA_HEADER]).setFontWeight('bold');
  created.setFrozenRows(1);
  return created;
}

function appendDataRecords(ledger, records) {
  const sheet = getDataSheet(ledger);
  const values = records.map(record => DATA_HEADER.map(column => {
    const value = record[column];
    return value === undefined || value === null ? '' : value;
  }));

  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, DATA_HEADER.length).setValues(values);
}

function readDataRecords(ledger) {
  const sheet = getDataSheet(ledger);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, DATA_HEADER.length).getValues();
  return values.map(row => {
    const record = {};
    DATA_HEADER.forEach((column, index) => { record[column] = row[index]; });
    return record;
  });
}

function getOrCreateSheet(ledger, name) {
  return ledger.getSheetByName(name) || ledger.insertSheet(name);
}

/**
 * One-time migration: record the content hash of every PDF already filed under
 * YYYY/MM, so the ledger knows about documents filed before it existed.
 *
 * Run this once before the first `processInvoices` if you have an existing
 * archive. Without it the ledger starts empty, every recent attachment looks
 * new, and triage files a second copy alongside the original.
 *
 * Cheap and idempotent - it only hashes files, and makes no Gemini calls. The
 * indexed documents are not reconciled (their contents were never extracted);
 * they are recorded purely so they are never re-downloaded. To reconcile them
 * too, move them back into staging instead.
 */
function indexExistingFiles() {
  const root = getRootFolder();
  const ledger = getLedgerSpreadsheet(root);

  const known = new Set();
  for (const record of readDataRecords(ledger)) {
    if (record.contentHash) known.add(String(record.contentHash));
  }

  const records = [];
  const yearFolders = root.getFolders();

  while (yearFolders.hasNext()) {
    const yearFolder = yearFolders.next();
    if (!/^\d{4}$/.test(yearFolder.getName())) continue;

    const monthFolders = yearFolder.getFolders();
    while (monthFolders.hasNext()) {
      const monthFolder = monthFolders.next();
      if (!/^\d{2}$/.test(monthFolder.getName())) continue;

      const month = `${yearFolder.getName()}-${monthFolder.getName()}`;
      const files = monthFolder.getFiles();

      while (files.hasNext()) {
        const file = files.next();
        if (!isPdfFile(file)) continue;

        try {
          const hash = getFileHash(file);
          if (known.has(hash)) continue;
          known.add(hash);

          records.push({
            kind: 'indexed',
            key: hash,
            fileName: file.getName(),
            contentHash: hash,
            month: month,
            date: '', party: '', amount: '', currency: '',
            direction: '', sourceFile: '',
            reference: 'pre-existing, not reconciled'
          });
        } catch (e) {
          console.error(`Could not hash ${file.getName()}: ${e.toString()}`);
        }
      }
    }
  }

  if (records.length) appendDataRecords(ledger, records);
  console.log(`Indexed ${records.length} pre-existing document(s).`);
}

/**
 * Hashes of every document already filed or staged, used to skip re-downloading
 * an attachment that has been seen before.
 */
function getKnownHashes(root, staging) {
  const hashes = new Set();

  for (const record of readDataRecords(getLedgerSpreadsheet(root))) {
    if (record.contentHash) hashes.add(String(record.contentHash));
  }

  const staged = staging.getFiles();
  while (staged.hasNext()) {
    try {
      hashes.add(getFileHash(staged.next()));
    } catch (e) {
      continue;
    }
  }

  return hashes;
}

/**
 * File and folder helpers
 */
function getRootFolder() {
  return getOrCreateFolder(getConfig('ROOT_FOLDER_NAME'));
}

function getOrCreateFolder(name) {
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function getOrCreateSubFolder(parentFolder, name) {
  const folders = parentFolder.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parentFolder.createFolder(name);
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function moveToMonthFolder(root, file, month, targetName) {
  const yearFolder = getOrCreateSubFolder(root, month.slice(0, 4));
  const monthFolder = getOrCreateSubFolder(yearFolder, month.slice(5, 7));
  file.setName(targetName);
  file.moveTo(monthFolder);
}

function moveToUnsorted(root, file) {
  file.moveTo(getOrCreateSubFolder(root, getConfig('UNSORTED_FOLDER_NAME')));
}

function unsortedRecord(file, reason) {
  return {
    kind: 'unsorted',
    key: getFileHash(file),
    fileName: file.getName(),
    contentHash: getFileHash(file),
    month: '',
    date: '',
    party: '',
    amount: '',
    currency: '',
    direction: '',
    sourceFile: '',
    reference: reason
  };
}

function isPdfAttachment(attachment) {
  const contentType = attachment.getContentType();
  return contentType === 'application/pdf' ||
    (contentType === 'application/octet-stream' &&
      attachment.getName().toLowerCase().endsWith('.pdf'));
}

function isPdfFile(file) {
  return file.getMimeType() === 'application/pdf' ||
    file.getName().toLowerCase().endsWith('.pdf');
}

/**
 * Derives a YYYY-MM label from an ISO date string.
 *
 * Deliberately string-based: constructing a Date and reading its month shifts
 * the day across a timezone boundary, which silently misfiles anything dated
 * the 1st or the last of a month.
 */
function monthOf(isoDate) {
  if (!isoDate) return null;
  const match = String(isoDate).match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function stripMonthPrefix(fileName) {
  return fileName.replace(/^\[\d{4}-\d{2}\]\s*/, '');
}

function entryKey(sourceFile, entry) {
  const parts = [sourceFile, entry.date, entry.description, entry.amount, entry.currency].join('|');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, parts)
    .map(byte => ('0' + (byte & 0xFF).toString(16)).slice(-2))
    .join('');
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (value === '' || value === null || value === undefined) return NaN;
  return Number(value);
}

/**
 * Calls Google Gemini API with a PDF file, with retry logic for rate limits.
 * Pass maxOutputTokens to override the configured limit (e.g. for long statements).
 */
function callGeminiWithPdf(prompt, pdfBlob, maxOutputTokens) {
  const geminiModel = getConfig('GEMINI_MODEL');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${getGeminiApiKey()}`;

  const pdfBytes = pdfBlob.getBytes();
  const base64Data = Utilities.base64Encode(pdfBytes);

  // Force correct MIME type for PDFs (some emails send PDFs as application/octet-stream)
  let mimeType = pdfBlob.getContentType();
  if (mimeType === 'application/octet-stream' && pdfBlob.getName().toLowerCase().endsWith('.pdf')) {
    mimeType = 'application/pdf';
  }

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Data
          }
        }
      ]
    }],
    generationConfig: {
      temperature: getConfig('TEMPERATURE'),
      maxOutputTokens: maxOutputTokens || getConfig('MAX_OUTPUT_TOKENS')
    }
  };

  const options = {
    method: 'post',
    headers: { 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload)
  };

  const maxRetries = getConfig('MAX_RETRIES');
  // Retry loop with exponential backoff
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const responseData = JSON.parse(response.getContentText());

      if (responseData.error) {
        throw new Error(`Gemini API error: ${responseData.error.message}`);
      }

      if (!responseData.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error('Unexpected response format from Gemini API');
      }

      return responseData.candidates[0].content.parts[0].text.trim();

    } catch (e) {
      const isRateLimit = e.message?.toLowerCase().includes('rate limit') ||
        e.message?.toLowerCase().includes('quota exceeded') ||
        (e.getResponseCode && e.getResponseCode() === 429);

      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.min(
          getConfig('INITIAL_DELAY_MS') * Math.pow(2, attempt),
          getConfig('MAX_DELAY_MS')
        );
        console.log(`Rate limit hit. Retrying in ${delay}ms (attempt ${attempt + 1})`);
        Utilities.sleep(delay);
        continue;
      }

      throw e;
    }
  }

  throw new Error('Failed to call Gemini API after all retries');
}

/**
 * Gets the page count of a PDF document.
 */
function getPdfPageCount(pdfBlob) {
  try {
    const pdfText = Utilities.newBlob(pdfBlob.getBytes()).getDataAsString();

    const countMatch = pdfText.match(/\/Count\s+(\d+)/);
    if (countMatch?.[1]) {
      const count = parseInt(countMatch[1], 10);
      if (count > 0) return count;
    }

    const pageMatches = pdfText.match(/\/Type\s*\/Page[^s]/g);
    if (pageMatches) return pageMatches.length;

    return 1;
  } catch (e) {
    return 1;
  }
}

/**
 * Generates a hash for file content to detect duplicates.
 */
function getFileHash(fileOrBlob) {
  let fileId = null;
  let blob = null;

  if (fileOrBlob.getId) {
    fileId = fileOrBlob.getId();
    if (HASH_CACHE[fileId]) return HASH_CACHE[fileId];
    blob = fileOrBlob.getBlob();
  } else {
    blob = fileOrBlob;
  }

  const bytes = blob.getBytes();
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(byte => ('0' + (byte & 0xFF).toString(16)).slice(-2))
    .join('');

  if (fileId) HASH_CACHE[fileId] = hash;

  return hash;
}

/**
 * Test function to verify Gmail search query works.
 */
function testGmailSearch() {
  const searchQuery = getConfig('GMAIL_SEARCH_QUERY');
  console.log(`Testing Gmail search with query: "${searchQuery}"`);
  try {
    const threads = GmailApp.search(searchQuery);
    console.log(`Found ${threads.length} threads`);

    if (threads.length === 0) {
      console.log('No threads found. Try testing the query directly in Gmail search bar.');
      return;
    }

    threads.forEach((thread, index) => {
      console.log(`\n--- Thread ${index + 1} ---`);
      thread.getMessages().forEach((message, msgIndex) => {
        console.log(`  Message ${msgIndex + 1}:`);
        console.log(`    To: ${message.getTo()}`);
        console.log(`    Subject: ${message.getSubject()}`);
        console.log(`    Date: ${message.getDate()}`);

        const attachments = message.getAttachments();
        console.log(`    Attachments: ${attachments.length}`);
        attachments.forEach((att, attIndex) => {
          console.log(`      ${attIndex + 1}. ${att.getName()} (${att.getContentType()})`);
        });
      });
    });
  } catch (e) {
    console.error(`Error searching Gmail: ${e.toString()}`);
  }
}
