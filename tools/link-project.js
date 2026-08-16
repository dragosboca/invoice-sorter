#!/usr/bin/env node
/**
 * Writes .clasp.json so clasp knows which Apps Script project to push to.
 *
 * The scriptId identifies a private project, so it is deliberately kept out of
 * version control. Supply it per-machine instead:
 *
 *   npm run link -- 1AbC...            # argument
 *   SCRIPT_ID=1AbC... npm run link     # environment
 *
 * Find it in the Apps Script editor URL
 * (script.google.com/home/projects/<SCRIPT_ID>/edit) or under
 * Project Settings -> Script ID.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '.clasp.json');

const scriptId = (process.argv[2] || process.env.SCRIPT_ID || '').trim();

if (!scriptId) {
  console.error(`No scriptId given.

  npm run link -- <scriptId>
  SCRIPT_ID=<scriptId> npm run link

Find it at Project Settings -> Script ID in the Apps Script editor.`);
  process.exit(1);
}

// Apps Script IDs are long URL-safe base64. Catch a pasted full URL early
// rather than failing later inside clasp with a vaguer error.
if (!/^[A-Za-z0-9_-]{20,}$/.test(scriptId)) {
  console.error(`"${scriptId}" does not look like a scriptId.

If you pasted a URL, take only the id:
  https://script.google.com/home/projects/<THIS_PART>/edit`);
  process.exit(1);
}

if (fs.existsSync(CONFIG_PATH)) {
  const current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (current.scriptId && current.scriptId !== scriptId) {
    console.log(`Repointing from ${current.scriptId.slice(0, 8)}... to ${scriptId.slice(0, 8)}...`);
  }
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify({ scriptId, rootDir: './' }, null, 2) + '\n');

console.log(`Linked to ${scriptId.slice(0, 8)}... (.clasp.json written, gitignored)`);
console.log('Next: npm run deploy');
