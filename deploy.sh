#!/bin/bash

# Ensure errors stop the script
set -e

echo "🔹 Initializing Invoice Sorter Deployment..."

# 1. Install Dependencies
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies (clasp)..."
  npm install
else
  echo "✅ Dependencies already installed."
fi

# 2. Check for Clasp Configuration
if [ ! -f ".clasp.json" ]; then
  echo "⚠️  No Google Apps Script project linked (.clasp.json is missing)."
  echo "   It is gitignored on purpose: it holds YOUR script id."
  echo ""
  echo "   STEP A: Login to Google"
  echo "   > npm run login"
  echo ""
  echo "   STEP B: Point this repo at a project — either create a new one:"
  echo "   > npm run create"
  echo ""
  echo "           ...or link an existing one by its Script ID:"
  echo "   > npm run link -- <SCRIPT_ID>"
  echo ""
  echo "   Once you have done these two steps, run this script again."
  exit 1
fi

# 3. Push Code
echo "🚀 Pushing code to Google Apps Script..."
npm run deploy

echo "✅ Deployment complete!"
echo "   Visit https://script.google.com/ to see your project."
echo "   Don't forget to set up the Trigger manually in the UI!"
