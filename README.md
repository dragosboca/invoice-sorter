# Automated Invoice Sorter (Google Apps Script)

This project contains a Google Apps Script to automate the organization of invoice PDFs from Gmail into Google Drive folders structured by Year/Month.

## Features

- **Gmail Search:** Finds emails with attachments (excluding emails from yourself).
- **Direct PDF Processing:** Sends PDFs directly to Gemini API (no OCR needed).
- **LLM-Based Invoice Detection:** Uses Google Gemini to intelligently determine if a document is an invoice.
- **Smart Date Detection:** Uses Google Gemini to accurately extract the invoice date.
- **Auto-Organization:** Saves invoice files to Google Drive in `Invoices/YYYY/MM/` folders.
- **Processed Labeling:** Adds a label to processed emails to avoid duplicates.
- **Duplicate Detection:** Prevents reprocessing by checking file hashes and names.
- **Handles Multiple Content Types:** Processes PDFs even when mislabeled as `application/octet-stream`.

## Setup Instructions

### Option A: Deploy with Clasp (Recommended)

If you want to deploy directly from your local machine using the command line:

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Login to Google:**
   ```bash
   npm run login
   ```
   This will open a browser window to authenticate with your Google account.

3. **Create a new Apps Script project:**
   ```bash
   npm run create
   ```
   This creates a new standalone Apps Script project in your Google account.

4. **Deploy the code:**
   ```bash
   npm run deploy
   ```
   Or simply run the deploy script:
   ```bash
   ./deploy.sh
   ```

5. **Continue with configuration** - Skip to step 3 below to configure the API key and settings.

### Option B: Manual Setup via Web Interface

### 1. Create a New Script
1. Go to [script.google.com](https://script.google.com/).
2. Click **New Project**.
3. Rename the project to "Invoice Sorter" (or similar).

### 2. Copy Code
1. Copy the contents of `Code.js` from this repository.
2. Paste it into the `Code.gs` file in the Apps Script editor (replace existing content).

### 3. Get Google Gemini API Key
The script uses Google's Gemini API for intelligent invoice detection and date extraction.
1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
2. Sign in with your Google account.
3. Click **Create API Key**.
4. Copy the API key.

### 4. Configure Script Properties
The script uses Script Properties to store sensitive configuration securely (not in the code).

**Required property:**

1. In the Apps Script editor, click the **Project Settings** (gear icon) in the left sidebar.
2. Scroll down to the **Script Properties** section.
3. Click **Add script property** and add:

| Property Name | Value | Example |
|---------------|-------|---------|
| `GEMINI_API_KEY` | Your Gemini API key from step 3 | `AIzaSyD...` |

4. Click **Save script properties**.

**Optional:** To customize the Gmail search query, add:

| Property Name | Value | Default |
|---------------|-------|---------|
| `GMAIL_SEARCH_QUERY` | Gmail search query to find invoices | `from:-me has:attachment newer_than:35d` |

**Example Gmail search queries:**
- **Basic:** `from:-me has:attachment newer_than:35d`
  - Finds emails not from you, with attachments, from the last 35 days
- **Specific recipients:** `from:-me (to:invoices@example.com OR to:billing@example.com) has:attachment`
  - Only emails sent to specific addresses
- **Exclude file types:** `from:-me has:attachment -filename:.ics newer_than:35d`
  - Excludes calendar invites (.ics files)
- **Specific sender domain:** `from:@example.com has:attachment filename:pdf`
  - Only from specific domain with PDF attachments

💡 **Tip:** Test your query in Gmail's search bar first to see which emails it matches!

### 5. Additional Configuration (Optional)
All configuration can be customized via Script Properties without editing the code. Add any of these properties to override defaults:

| Property Name | Description | Default Value |
|---------------|-------------|---------------|
| `ROOT_FOLDER_NAME` | Google Drive folder name | `Invoices` |
| `PROCESSED_LABEL` | Gmail label for processed emails (set to `null` to disable) | `Processed-Invoice` |
| `GEMINI_MODEL` | Gemini model to use | `gemini-3-pro-preview` |
| `MAX_PDF_PAGES` | Maximum pages to process (skip larger documents) | `10` |
| `TEMPERATURE` | LLM temperature for deterministic responses | `0.1` |
| `MAX_OUTPUT_TOKENS` | Maximum tokens in API response | `2048` |
| `MAX_RETRIES` | Number of retries for rate limits | `5` |
| `INITIAL_DELAY_MS` | Initial retry delay in milliseconds | `1000` |
| `MAX_DELAY_MS` | Maximum retry delay in milliseconds | `30000` |

**Example:** To change the folder name to "Bills", add a Script Property:
- Name: `ROOT_FOLDER_NAME`
- Value: `Bills`

### 6. Test Run
1. **Optional:** First test your Gmail search query by running `testGmailSearch()` to see which emails match.
2. Select the `processInvoices` function from the toolbar dropdown.
3. Click **Run**.
4. You will be asked to authorize permissions (Gmail, Drive, etc.).
5. Check the "Execution Log" to see the progress.

### 7. Set Up Automation (Trigger)
1. Click on **Triggers** (clock icon) in the left sidebar.
2. Click **Add Trigger**.
3. **Choose which function to run:** `processInvoices`.
4. **Select event source:** `Time-driven`.
5. **Select type of time based trigger:** `Month timer`.
6. **Select day of month:** `1st`.
7. **Select time of day:** (Choose a time, e.g., `Midnight to 1am`).
8. Click **Save**.

Now the script will run automatically on the 1st of every month!

## How It Works

1. **Search Gmail** for emails matching the configured query.
2. **Extract attachments** and check if they are PDFs (by content type or file extension).
3. **Check page count** - Skip documents with too many pages (likely not invoices).
4. **Quick duplicate check** - Skip if the file already exists in the Drive structure.
5. **Invoice detection** - Use Gemini AI to verify it's actually an invoice.
6. **Date extraction** - Use Gemini AI to extract the invoice date.
7. **Save to Drive** - Create `Invoices/YYYY/MM/` folders and save with date prefix.
8. **Label email** - Add a "Processed-Invoice" label to the Gmail thread.

## Troubleshooting

### Script says "Gemini API key not found"
Add the API key to Script Properties as described in step 4.

### PDFs are being skipped
Check the execution logs. The script shows why each attachment is skipped:
- "Skipping non-PDF" - File is not a PDF
- "Skipping: N pages" - Document has too many pages
- "Not an invoice" - Gemini determined it's not an invoice
- "No date found" - Gemini couldn't extract an invoice date

### Want to see what emails are being found?
Run the `testGmailSearch()` function to see all matching emails and their attachments.

## Configuration Options

In the `CONFIG` object:
- `SEARCH_QUERY` - Gmail search query to find emails
- `ROOT_FOLDER_NAME` - Name of the root folder in Google Drive
- `PROCESSED_LABEL` - Gmail label to add to processed threads (set to `null` to disable)
- `GEMINI.MODEL` - Gemini model to use (e.g., `gemini-3-pro-preview`)
- `GEMINI.MAX_PDF_PAGES` - Maximum pages to process (default: 2)
- `GEMINI.MAX_RETRIES` - Number of retries for API rate limits (default: 5)
