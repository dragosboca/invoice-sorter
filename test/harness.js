/**
 * Loads Code.js against the fake Apps Script services in fakes.js.
 *
 * Code.js is written for the Apps Script runtime, so it cannot be require()d.
 * It is read as text and evaluated with the Google globals supplied as
 * parameters, which lets every function be exercised in plain Node.
 */
const fs = require('fs');
const path = require('path');
const fakes = require('./fakes.js');

const CODE_PATH = path.join(__dirname, '..', 'Code.js');

/**
 * Builds a Gemini stub. Fake PDFs carry a marker string describing what the
 * model should "see", so tests declare model output without any network call.
 *
 *   INVOICE|vendor|date|total|currency
 *   STATEMENT|periodStart|periodEnd|date,desc,amount,currency,direction;...
 *   anything else -> {"type":"other"}
 */
function makeGeminiStub(state) {
  return {
    fetch(url, options) {
      // The models-list endpoint is a bare GET, not a generateContent call.
      if (/\/models\?/.test(url)) {
        state.modelListCalls++;
        return {
          getContentText: () => JSON.stringify({
            models: (state.models || ['gemini-pro-latest', 'gemini-flash-latest'])
              .map(name => ({ name: 'models/' + name, supportedGenerationMethods: ['generateContent'] }))
              .concat([{ name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }])
          })
        };
      }

      state.geminiCalls++;

      const payload = JSON.parse(options.payload);
      const marker = Buffer.from(
        payload.contents[0].parts[1].inline_data.data, 'base64').toString();

      let result;
      if (marker.startsWith('INVOICE|')) {
        const [, vendor, date, total, currency] = marker.split('|');
        result = { type: 'invoice', vendor, invoice_number: 'X1', date, total: Number(total), currency };
      } else if (marker.startsWith('STATEMENT|')) {
        const [, start, end, entries] = marker.split('|');
        result = {
          type: 'account_statement',
          period: { start, end },
          entries: (entries || '').split(';').filter(Boolean).map(raw => {
            const [date, description, amount, currency, direction] = raw.split(',');
            return { date, description, amount: Number(amount), currency, direction };
          })
        };
      } else {
        result = { type: 'other' };
      }

      // Fenced deliberately: also exercises the fence-tolerant parser.
      const text = '```json\n' + JSON.stringify(result) + '\n```';
      return {
        getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })
      };
    }
  };
}

const EXPORTS = `;module.exports={
  processInvoices,fetchToStaging,triageStaging,rebuildLedger,indexExistingFiles,
  getRootFolder,getLedgerSpreadsheet,readDataRecords,appendDataRecords,getKnownHashes,
  matchEntriesToInvoices,buildLedgerRows,writeMonthViews,readExistingNotes,
  parseGeminiJson,getPdfPageCount,isPdfFile,isPdfAttachment,monthOf,stripMonthPrefix,listAvailableModels,
  toCsvCell,toNumber,entryKey,dateOf,getConfig,
  DATA_HEADER,VIEW_HEADER};`;

/**
 * Loads a fresh copy of Code.js with fresh fake Drive state.
 *
 * @param {object} opts.gmailThreads Threads the fake GmailApp should return.
 * @param {function} opts.onHit      Optional coverage callback, per function call.
 */
function load(opts) {
  opts = opts || {};
  fakes.reset();

  const state = { geminiCalls: 0, modelListCalls: 0, labelled: [], models: opts.models };

  const GmailApp = {
    search: () => opts.gmailThreads || [],
    getUserLabelByName: name => ({ getName: () => name }),
    createLabel: name => ({ getName: () => name })
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: key => {
        if (key === 'GEMINI_API_KEY') return 'test-key';
        return (opts.properties && key in opts.properties) ? opts.properties[key] : null;
      }
    })
  };

  let source = fs.readFileSync(CODE_PATH, 'utf8');
  if (opts.onHit) {
    source = source.replace(/^function (\w+)(\s*\([^)]*\)\s*\{)/gm,
      (_m, name, rest) => `function ${name}${rest} __hit('${name}');`);
  }

  const module_ = { exports: {} };
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };

  new Function('__hit', 'module', 'console', 'PropertiesService', 'Utilities',
    'DriveApp', 'GmailApp', 'SpreadsheetApp', 'Session', 'UrlFetchApp',
    source + EXPORTS)(
    opts.onHit || (() => {}), module_, opts.verbose ? console : quiet,
    PropertiesService, fakes.Utilities, fakes.DriveApp, GmailApp,
    fakes.SpreadsheetApp, {}, makeGeminiStub(state));

  return { api: module_.exports, state, fakes };
}

/** Lists every top-level function name in Code.js, for coverage reporting. */
function functionNames() {
  const source = fs.readFileSync(CODE_PATH, 'utf8');
  return [...source.matchAll(/^function (\w+)\s*\(/gm)].map(m => m[1]);
}

module.exports = { load, functionNames, CODE_PATH };
