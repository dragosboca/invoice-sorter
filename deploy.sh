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
  echo "⚠️  No Google Apps Script project found (.clasp.json is missing)."
  echo "   You need to authenticate and create a project first."
  echo ""
  echo "   STEP A: Login to Google"
  echo "   > npm run login"
  echo ""
  echo "   STEP B: Create the project"
  echo "   > npm run create"
  echo ""
  echo "   Once you have done these two steps manually, run this script again."
  exit 1
fi

# 3. Push Code
echo "🚀 Pushing code to Google Apps Script..."
npm run deploy

echo "✅ Deployment complete!"
echo "   Visit https://script.google.com/ to see your project."
echo "   Don't forget to set up the Trigger manually in the UI!"
