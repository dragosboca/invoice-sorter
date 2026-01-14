/**
 * Google Apps Script to automate invoice sorting.
 *
 * This script sends PDFs directly to Gemini API for processing (no OCR needed).
 *
 * Also requires a Gemini API key from https://aistudio.google.com/app/apikey
 * Set it in the CONFIG.GEMINI.API_KEY field below.
 */

// Hash cache to avoid recomputing hashes for the same files
const HASH_CACHE = {};

// Default Configuration (can be overridden via Script Properties)
const DEFAULTS = {
  GMAIL_SEARCH_QUERY: 'from:-me has:attachment newer_than:35d',
  ROOT_FOLDER_NAME: 'Invoices',
  PROCESSED_LABEL: 'Processed-Invoice',
  GEMINI_MODEL: 'gemini-3-pro-preview',
  MAX_PDF_PAGES: 10,
  TEMPERATURE: 0.1,
  MAX_OUTPUT_TOKENS: 2048,
  MAX_RETRIES: 5,
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 30000
};

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

    // Show details for all threads
    threads.forEach((thread, index) => {
      console.log(`\n--- Thread ${index + 1} ---`);
      const messages = thread.getMessages();

      messages.forEach((message, msgIndex) => {
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

/**
 * Main function to be triggered monthly.
 */
function processInvoices() {
  const searchQuery = getConfig('GMAIL_SEARCH_QUERY');
  const threads = GmailApp.search(searchQuery);
  console.log(`Found ${threads.length} threads matching query.`);

  if (threads.length === 0) return;

  const rootFolder = getOrCreateFolder(getConfig('ROOT_FOLDER_NAME'));

  for (const thread of threads) {
    let hasProcessedInvoice = false;
    const messages = thread.getMessages();

    for (const message of messages) {
      const attachments = message.getAttachments();

      for (const attachment of attachments) {
        const contentType = attachment.getContentType();
        const fileName = attachment.getName();
        console.log(`Found attachment: ${fileName} (${contentType})`);

        const isPdf = contentType === 'application/pdf' ||
          (contentType === 'application/octet-stream' && fileName.toLowerCase().endsWith('.pdf'));

        if (isPdf) {
          const processed = processAttachment(attachment, rootFolder);
          if (processed) hasProcessedInvoice = true;
        } else {
          console.log(`Skipping non-PDF: ${fileName}`);
        }
      }
    }

    const processedLabel = getConfig('PROCESSED_LABEL');
    if (processedLabel && hasProcessedInvoice) {
      const label = getOrCreateLabel(processedLabel);
      thread.addLabel(label);
    }
  }
}

/**
 * Processes a single PDF attachment.
 */
function processAttachment(attachment, rootFolder) {
  try {
    console.log(`Processing: ${attachment.getName()}`);

    // Check PDF page count
    const pageCount = getPdfPageCount(attachment);
    const maxPages = getConfig('MAX_PDF_PAGES');
    if (pageCount > maxPages) {
      console.log(`Skipping: ${pageCount} pages (max: ${maxPages})`);
      return false;
    }

    // Quick duplicate check
    const attachmentHash = getFileHash(attachment);
    if (fileExistsInInvoiceStructure(rootFolder, attachment.getName(), attachmentHash)) {
      console.log(`Already exists: ${attachment.getName()}`);
      return true;
    }

    // Check if document is an invoice
    if (!checkIfInvoice(attachment)) {
      console.log(`Not an invoice: ${attachment.getName()}`);
      return false;
    }

    // Extract invoice date
    const invoiceDate = extractInvoiceDate(attachment);
    if (!invoiceDate) {
      console.warn(`No date found: ${attachment.getName()}`);
      return false;
    }

    // Save to folder
    const year = invoiceDate.getFullYear().toString();
    const month = ('0' + (invoiceDate.getMonth() + 1)).slice(-2);
    const yearFolder = getOrCreateSubFolder(rootFolder, year);
    const targetFolder = getOrCreateSubFolder(yearFolder, month);
    const targetFileName = `[${year}-${month}] ${attachment.getName()}`;

    // Final duplicate check in target folder
    if (fileExistsInFolder(targetFolder, targetFileName) ||
      fileWithHashExistsInFolder(targetFolder, attachmentHash)) {
      console.log(`Duplicate in target folder: ${targetFileName}`);
      return true;
    }

    const file = targetFolder.createFile(attachment);
    file.setName(targetFileName);

    // Cache the hash for the newly created file
    HASH_CACHE[file.getId()] = attachmentHash;

    console.log(`Saved: ${year}/${month}/${file.getName()}`);

    return true;

  } catch (e) {
    console.error(`Error processing ${attachment.getName()}: ${e.toString()}`);
    return false;
  }
}

/**
 * Checks if a document is an invoice using LLM.
 */
function checkIfInvoice(pdfBlob) {
  const prompt = `Analyze this PDF document and determine if it is an invoice or billing document.

Document filename: ${pdfBlob.getName()}

Is this document an invoice or billing document? Respond with only "YES" or "NO".`;

  try {
    const response = callGeminiWithPdf(prompt, pdfBlob);
    return response.trim().toUpperCase().startsWith('YES');
  } catch (e) {
    console.error(`Error checking invoice: ${e.toString()}`);
    return false;
  }
}

/**
 * Extracts the invoice date from PDF using LLM.
 */
function extractInvoiceDate(pdfBlob) {
  const prompt = `Extract the invoice date from this invoice PDF document.
Look for the actual invoice date, issue date, or billing date - NOT other dates like due dates, order dates, or service period dates.
The invoice can be written in different languages, so you need to be able to understand the language and extract the date.

Extract ONLY the invoice date in ISO format (YYYY-MM-DD). If you cannot find a clear invoice date, respond with "NOT_FOUND".
Respond with ONLY the date in YYYY-MM-DD format, nothing else.`;

  try {
    const response = callGeminiWithPdf(prompt, pdfBlob);
    const dateString = response.trim();

    if (dateString === 'NOT_FOUND' || !dateString) return null;

    const date = new Date(dateString);
    return (date instanceof Date && !isNaN(date)) ? date : null;
  } catch (e) {
    console.error(`Error extracting date: ${e.toString()}`);
    return null;
  }
}

/**
 * Calls Google Gemini API with a PDF file, with retry logic for rate limits.
 */
function callGeminiWithPdf(prompt, pdfBlob) {
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
      maxOutputTokens: getConfig('MAX_OUTPUT_TOKENS')
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
 * Folder management helpers
 */
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
 * Checks if a file with the given name exists in a folder.
 */
function fileExistsInFolder(folder, fileName) {
  return folder.getFilesByName(fileName).hasNext();
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
 * Checks if a file with the same content hash exists in a folder.
 */
function fileWithHashExistsInFolder(folder, contentHash) {
  const files = folder.getFiles();

  while (files.hasNext()) {
    try {
      const file = files.next();
      if (getFileHash(file) === contentHash) return true;
    } catch (e) {
      continue;
    }
  }

  return false;
}

/**
 * Checks if a file already exists anywhere in the invoice folder structure.
 */
function fileExistsInInvoiceStructure(rootFolder, fileName, contentHash) {
  if (rootFolder.getFilesByName(fileName).hasNext()) return true;

  const yearFolders = rootFolder.getFolders();
  while (yearFolders.hasNext()) {
    const yearFolder = yearFolders.next();
    const monthFolders = yearFolder.getFolders();

    while (monthFolders.hasNext()) {
      const monthFolder = monthFolders.next();
      if (fileWithHashExistsInFolder(monthFolder, contentHash)) return true;
    }

    if (fileWithHashExistsInFolder(yearFolder, contentHash)) return true;
  }

  return fileWithHashExistsInFolder(rootFolder, contentHash);
}
