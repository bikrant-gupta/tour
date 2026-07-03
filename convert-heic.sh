#!/bin/bash
# ============================================
# convert-heic.sh — Batch convert HEIC → JPEG
# ============================================
#
# Converts all .HEIC and .heic files under the
# images/ directory to .jpg using macOS sips.
#
# Usage:
#   chmod +x convert-heic.sh
#   ./convert-heic.sh
#
# After running, update your data.json to reference
# .jpg filenames instead of .HEIC
# ============================================

IMAGES_DIR="./images"
COUNT=0
SKIPPED=0

echo "🔍 Scanning for HEIC files in $IMAGES_DIR..."
echo ""

find "$IMAGES_DIR" -type f \( -iname "*.heic" -o -iname "*.heif" \) | while read -r heic_file; do
  # Build output path: replace extension with .jpg
  jpg_file="${heic_file%.*}.jpg"

  if [ -f "$jpg_file" ]; then
    echo "  ⏭  Skipping (already exists): $(basename "$jpg_file")"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo "  📸 Converting: $heic_file"
  sips -s format jpeg "$heic_file" --out "$jpg_file" > /dev/null 2>&1

  if [ $? -eq 0 ]; then
    # Get file sizes for comparison
    heic_size=$(stat -f%z "$heic_file" 2>/dev/null || stat --printf="%s" "$heic_file" 2>/dev/null)
    jpg_size=$(stat -f%z "$jpg_file" 2>/dev/null || stat --printf="%s" "$jpg_file" 2>/dev/null)
    echo "     ✅ → $(basename "$jpg_file") (${heic_size} → ${jpg_size} bytes)"
    COUNT=$((COUNT + 1))
  else
    echo "     ❌ Failed to convert: $heic_file"
  fi
done

echo ""
echo "✨ Done! Remember to update data.json to use .jpg filenames."
