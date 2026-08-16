# Automated Invoice Sorter & Statement Reconciler (Google Apps Script)

A Google Apps Script that files invoice PDFs and bank statements from Gmail into
Google Drive by Year/Month, then keeps a running ledger telling you **which
statement charges have no matching invoice**.

## How it works

```
Gmail ──▶ _Staging ──▶ YYYY/MM/ ──▶ Reconciliation Ledger
         (fetch)      (triage)      (rebuild)
```

Every PDF — invoice or account statement, emailed by your bank or dropped into
the staging folder by hand — goes through one queue, gets classified by Gemini
**exactly once**, and is filed by date.

- **Invoices** file under their invoice date.
- **Statements** file under the period they *cover*, not the date they arrived —
  so a July statement emailed on August 1st sits with the July invoices it
  reconciles.
- **Anything else** moves to `_Unsorted/`, so staging stays a true queue (empty
  means done) and a rejected file is never sent to Gemini twice.

The ledger is a Google Sheet holding every statement entry and every invoice
ever seen. Matching runs across the **whole ledger**, not per folder — so an
invoice dated July 28th charged on the August statement still matches. Month
boundaries are a presentation detail, not a correctness problem.

### Folder layout

```
Invoices/
├── _Staging/                     drop PDFs here (or let Gmail fill it)
├── _Unsorted/                    failed triage, for review
├── Reconciliation Ledger         Google Sheet — the source of truth
└── 2026/
    └── 07/
        ├── [2026-07] acme-invoice.pdf
        ├── [2026-07] bank-statement.pdf
        └── reconciliation-2026-07.csv    derived snapshot
```

### The ledger

One tab per month, each row one of four states:

| Status | Meaning |
|--------|---------|
| `MISSING INVOICE` | **A charge with no invoice — what you're looking for.** |
| `NEEDS REVIEW` | Entry the model couldn't clearly mark debit or credit. Not matched, never silently dropped. |
| `NO STATEMENT ENTRY` | Invoice not yet charged, or its statement hasn't arrived. |
| `MATCHED` | Reconciled. |

Rows are sorted with problems first. A **Notes** column is preserved across
rebuilds (keyed by row), so anything you type by hand survives.

The `_Data` tab holds the raw extraction records. It is also the deduplication
index — one sheet read instead of walking every folder in Drive — so re-running
never re-bills you for a document already processed.

## Setup

### Option A: Deploy with Clasp (Recommended)

```bash
npm install
npm run login                  # browser consent
```

Then point the repo at an Apps Script project — **either** create a new one:

```bash
npm run create
```

**or** link an existing one, using its Script ID from the editor URL
(`script.google.com/home/projects/<SCRIPT_ID>/edit`, or Project Settings →
Script ID):

```bash
npm run link -- <SCRIPT_ID>
# or: SCRIPT_ID=<SCRIPT_ID> npm run link
```

Then deploy:

```bash
npm run deploy                 # runs the test suite first
```

`npm run link` writes `.clasp.json`, which holds **your** Script ID and is
gitignored — nothing machine-specific is ever committed. See
`.clasp.json.example` for the shape. A `.claspignore` allowlist means only
`Code.js` and `appsscript.json` are ever uploaded; tests and local tooling stay
on your machine.

To inspect what is currently live before overwriting it:

```bash
npm run pull                   # WARNING: overwrites local Code.js
```

Prefer pulling into a scratch directory if you have uncommitted work.

### Option B: Manual Setup

1. Go to [script.google.com](https://script.google.com/) → **New Project**.
2. Copy `Code.js` into `Code.gs`, replacing the existing content.

### Gemini API key (required)

1. Get a key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
2. In the Apps Script editor: **Project Settings** (gear) → **Script Properties**
   → **Add script property**.
3. Name `GEMINI_API_KEY`, value your key. Save.

### Gmail query

Have your bank email you the account statement, and make sure the query matches
both it and your invoices.

| Property | Default |
|----------|---------|
| `GMAIL_SEARCH_QUERY` | `from:-me has:attachment newer_than:35d` |

Examples:
- `from:-me has:attachment newer_than:35d` — not from you, with attachments, last 35 days
- `from:-me (to:invoices@example.com OR from:@mybank.com) has:attachment`
- `from:-me has:attachment -filename:.ics newer_than:35d` — excludes calendar invites

💡 Test the query in Gmail's search bar first, or run `testGmailSearch()`.

### Migrating an existing archive (do this first)

**If you already have invoices filed under `Invoices/YYYY/MM/` from a previous
version, run `indexExistingFiles()` once before anything else.**

The ledger doubles as the deduplication index. Starting empty, it would treat
every recent Gmail attachment as new and file a *second copy* of documents you
already have. `indexExistingFiles()` walks the existing `YYYY/MM` folders and
records each file's content hash, which is enough to make them recognisable.

It makes no Gemini calls, is safe to re-run, and moves nothing. Indexed files
are recorded as already-seen but are *not* reconciled — their contents were
never extracted. To reconcile them too, move them back into `_Staging/`.

Starting fresh with an empty `Invoices/` folder? Skip this.

### First run

1. Select `processInvoices` in the toolbar dropdown → **Run**.
2. Authorize when prompted (Gmail, Drive, Sheets).
3. Watch the execution log, then open the **Reconciliation Ledger** in `Invoices/`.

### Automate it

**Triggers** (clock icon) → **Add Trigger** → function `processInvoices`,
source `Time-driven`, type `Month timer`, day `1st`. Run it a few days into the
month so the previous month's statement has arrived.

## Configuration

All optional, all via Script Properties.

| Property | Description | Default |
|----------|-------------|---------|
| `ROOT_FOLDER_NAME` | Drive folder for everything | `Invoices` |
| `STAGING_FOLDER_NAME` | Pre-triage queue | `_Staging` |
| `UNSORTED_FOLDER_NAME` | Failed triage | `_Unsorted` |
| `LEDGER_NAME` | Ledger spreadsheet name | `Reconciliation Ledger` |
| `PROCESSED_LABEL` | Gmail label for processed threads (`null` disables) | `Processed-Invoice` |
| `GEMINI_MODEL` | Gemini model | `gemini-pro-latest` |
| `MAX_PDF_PAGES` | Sanity cap; larger PDFs go to `_Unsorted` | `50` |
| `MATCH_DATE_WINDOW_DAYS` | Max days between invoice date and charge | `14` |
| `MATCH_AMOUNT_TOLERANCE` | Max amount difference for a match | `0.01` |
| `WRITE_MONTH_CSV` | Write a CSV snapshot per month folder | `true` |
| `EXTRACTION_MAX_OUTPUT_TOKENS` | Token limit for extraction | `8192` |
| `TEMPERATURE` | LLM temperature | `0.1` |
| `MAX_RETRIES` / `INITIAL_DELAY_MS` / `MAX_DELAY_MS` | Rate-limit backoff | `5` / `1000` / `30000` |

`MAX_PDF_PAGES` defaults to 50, not 10: a document's type is unknown until it
has been classified, so the cap must not reject a long statement before anyone
looks at it.

## Running the phases separately

`processInvoices` runs all three in order. Each is independently runnable, which
is useful for debugging and for large backfills:

| Function | Does |
|----------|------|
| `fetchToStaging()` | Gmail → `_Staging`, skipping anything already seen |
| `triageStaging()` | Classify, file by date, record in the ledger |
| `rebuildLedger()` | Re-match everything, rewrite month tabs and CSVs |
| `indexExistingFiles()` | One-time migration: register a pre-existing archive. No API calls |
| `listAvailableModels()` | List the models your API key can actually call |
| `testGmailSearch()` | Show what the query matches, no changes |

`rebuildLedger()` makes **no API calls** — it works from stored records, so
re-running it after tweaking `MATCH_DATE_WINDOW_DAYS` is free and instant.

## Tests

```bash
npm test
```

`Code.js` targets the Apps Script runtime, so it can't be `require`d. The suite
reads it as text and evaluates it against in-memory fakes for Drive, Gmail,
Sheets and the Gemini API (`test/fakes.js`), which lets every phase run in plain
Node with no network and no Google account. Gemini responses are declared by a
marker string inside each fake PDF, so tests state what the model "sees".

65 checks, 40 of 41 functions executed. Coverage is printed after each run.

**What this does and doesn't prove.** It covers logic, control flow and the
regressions worth guarding — cross-month matching, dedup, note preservation,
idempotency. It does **not** prove the real Google APIs behave the way the fakes
do, nor that Gemini extracts real-world PDFs correctly. Test on a copy of one
month's folder before pointing it at your archive.

`npm run deploy` runs the suite first via `predeploy`.

## Notes and limits

- **Execution time.** Triage costs one Gemini call per PDF, 5–20s each, against
  Apps Script's 6-minute cap (30 min on Workspace). Roughly 20–60 documents per
  run. This is *resumable*: triage moves each file out of staging as it
  finishes, so if a run times out, just run it again.
- **Transient failures stay put.** A document that errors during triage is left
  in staging rather than moved to `_Unsorted`, so an API blip never quietly
  buries a real invoice.
- **Matching is conservative.** One invoice matches at most one charge, both
  amounts must be real numbers, currencies must agree, and dates must fall
  within the window. An invoice whose total the model failed to read is
  reported as unmatched rather than guessed at.
- **Credits are excluded** from matching and only counted.
- **CSV snapshots are derived.** Don't hand-edit them — they're overwritten on
  every rebuild. Put annotations in the ledger's Notes column instead.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| "Gemini API key not configured" | Add `GEMINI_API_KEY` to Script Properties |
| Every document fails extraction | The model ID may not exist for your key. Run `listAvailableModels()` and set `GEMINI_MODEL` to one it lists |
| Files pile up in `_Staging` | Triage is erroring — check the log; transient errors leave files in place deliberately |
| Real invoices land in `_Unsorted` | Model misclassified, or the PDF exceeds `MAX_PDF_PAGES`. Move them back to `_Staging` to retry |
| Everything shows `MISSING INVOICE` | The statement was filed but its invoices weren't — check `_Unsorted` |
| Charges show as `NEEDS REVIEW` | The model didn't mark debit/credit. Fill them in manually or re-run triage on that statement |
| `Exceeded maximum execution time` | Expected on a backlog. Run again — it resumes |
