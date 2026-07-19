#!/bin/bash
# ============================================
# deploy.sh — Encrypt & push to GitHub Pages
# ============================================
# Usage: ./deploy.sh
# ============================================
set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Tour Explorer — Deploy Script           ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Check we're in the right directory
if [ ! -f "encrypt.js" ]; then
  echo "❌  Run this from your Tour project directory."
  exit 1
fi

# Step 1: Encrypt
echo "🔐  Step 1/3: Encrypting…"
node encrypt.js
echo ""

# Step 2: Stage encrypted output
echo "📦  Step 2/3: Staging files…"
git add vault.json index.html .gitignore 2>/dev/null || true

# Stage all .enc image files
find images -name "*.enc" -print0 2>/dev/null | xargs -0 git add -f 2>/dev/null || true

echo ""

# Step 3: Commit & push
echo "🚀  Step 3/3: Committing & pushing…"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M")
git commit -m "deploy: encrypt & publish [$TIMESTAMP]" || echo "  (nothing new to commit)"
git push

echo ""
echo "══════════════════════════════════════════"
echo "  ✅  Live on GitHub Pages!"
echo "══════════════════════════════════════════"
echo ""
