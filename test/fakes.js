/**
 * Minimal in-memory fakes for the Apps Script services Code.js uses.
 *
 * Only the surface Code.js actually calls is implemented. Anything else throws
 * by omission, which is intentional: a test that needs more should say so.
 */
const crypto = require('crypto');

const iterator = items => {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
};

let nextId = 1;
let byId = {};
let driveRoot = [];
let spreadsheetByFileId = {};

class FakeBlob {
  constructor(bytes, name, mimeType) {
    this._bytes = bytes; this._name = name; this._mimeType = mimeType;
  }
  getBytes() { return this._bytes; }
  getName() { return this._name; }
  getContentType() { return this._mimeType; }
  getDataAsString() { return Buffer.from(this._bytes).toString('binary'); }
}

class FakeFile {
  constructor(name, bytes, mimeType, parent) {
    this.id = 'file-' + (nextId++);
    this._name = name; this._bytes = bytes; this._mimeType = mimeType; this._parent = parent;
    byId[this.id] = this;
  }
  getId() { return this.id; }
  getName() { return this._name; }
  setName(name) { this._name = name; return this; }
  getMimeType() { return this._mimeType; }
  getBlob() { return new FakeBlob(this._bytes, this._name, this._mimeType); }
  getContentText() { return Buffer.from(this._bytes).toString(); }
  setContent(text) { this._bytes = Buffer.from(text); return this; }
  moveTo(folder) {
    if (this._parent) this._parent._files = this._parent._files.filter(f => f !== this);
    folder._files.push(this);
    this._parent = folder;
    return this;
  }
}

class FakeFolder {
  constructor(name, parent) {
    this._name = name; this._parent = parent; this._files = []; this._folders = [];
  }
  getName() { return this._name; }
  getFiles() { return iterator(this._files.slice()); }
  getFolders() { return iterator(this._folders.slice()); }
  getFilesByName(name) { return iterator(this._files.filter(f => f.getName() === name)); }
  getFoldersByName(name) { return iterator(this._folders.filter(f => f.getName() === name)); }
  createFolder(name) {
    const folder = new FakeFolder(name, this);
    this._folders.push(folder);
    return folder;
  }
  createFile(a, b, c) {
    const file = typeof a === 'string'
      ? new FakeFile(a, Buffer.from(b || ''), c || 'text/plain', this)
      : new FakeFile(a.getName(), a.getBytes(), a.getContentType(), this);
    this._files.push(file);
    return file;
  }
}

const DriveApp = {
  getFoldersByName: name => iterator(driveRoot.filter(f => f.getName() === name)),
  createFolder: name => { const f = new FakeFolder(name, null); driveRoot.push(f); return f; },
  getFileById: id => byId[id]
};

class FakeSheet {
  constructor(name) { this._name = name; this.grid = []; }
  getName() { return this._name; }
  setName(name) { this._name = name; return this; }
  clear() { this.grid = []; return this; }
  setFrozenRows() { return this; }
  getLastRow() {
    let last = 0;
    this.grid.forEach((row, i) => {
      if (row && row.some(cell => cell !== '' && cell !== null && cell !== undefined)) last = i + 1;
    });
    return last;
  }
  getRange(row, col, numRows, numCols) {
    const sheet = this;
    return {
      setValues(values) {
        values.forEach((r, i) => {
          const target = row - 1 + i;
          sheet.grid[target] = sheet.grid[target] || [];
          r.forEach((value, j) => { sheet.grid[target][col - 1 + j] = value; });
        });
        return this;
      },
      getValues() {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const r = sheet.grid[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < numCols; j++) {
            const v = r[col - 1 + j];
            line.push(v === undefined ? '' : v);
          }
          out.push(line);
        }
        return out;
      },
      setFontWeight() { return this; }
    };
  }
}

class FakeSpreadsheet {
  constructor(name) {
    this._name = name; this._sheets = [new FakeSheet('Sheet1')]; this.id = 'sheet-' + (nextId++);
  }
  getId() { return this.id; }
  getSheets() { return this._sheets; }
  getSheetByName(name) { return this._sheets.find(s => s.getName() === name) || null; }
  insertSheet(name) { const s = new FakeSheet(name); this._sheets.push(s); return s; }
}

const SpreadsheetApp = {
  create(name) {
    const spreadsheet = new FakeSpreadsheet(name);
    const file = new FakeFile(name, Buffer.from(''), 'application/vnd.google-apps.spreadsheet', null);
    byId[spreadsheet.getId()] = file;
    spreadsheetByFileId[file.getId()] = spreadsheet;
    return spreadsheet;
  },
  open(file) { return spreadsheetByFileId[file.getId()]; }
};

const Utilities = {
  DigestAlgorithm: { MD5: 'MD5' },
  computeDigest: (_algorithm, data) =>
    [...crypto.createHash('md5').update(Buffer.from(data)).digest()],
  base64Encode: bytes => Buffer.from(bytes).toString('base64'),
  newBlob: bytes => new FakeBlob(bytes, 'blob', 'application/pdf'),
  sleep: () => {}
};

/** A Gmail attachment: a blob-alike, as GmailApp returns. */
function fakeAttachment(name, marker, mimeType) {
  return {
    getName: () => name,
    getBytes: () => Buffer.from(marker),
    getContentType: () => mimeType || 'application/pdf'
  };
}

/** A Gmail thread carrying one message with the given attachments. */
function fakeThread(attachments) {
  const labels = [];
  return {
    labels,
    getMessages: () => [{
      getAttachments: () => attachments,
      getTo: () => 'me@example.com',
      getSubject: () => 'test',
      getDate: () => '2026-08-01'
    }],
    addLabel: label => labels.push(label)
  };
}

/** Clears all in-memory Drive state between tests. */
function reset() {
  nextId = 1;
  byId = {};
  driveRoot = [];
  spreadsheetByFileId = {};
}

module.exports = {
  DriveApp, SpreadsheetApp, Utilities,
  fakeAttachment, fakeThread, reset,
  get driveRoot() { return driveRoot; }
};
