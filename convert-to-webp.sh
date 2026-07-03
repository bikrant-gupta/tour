#!/bin/bash
# ============================================
# convert-to-webp.sh — Batch convert images to WebP
# ============================================
#
# Converts all .jpg / .jpeg / .png files under the
# images/ directory to .webp using cwebp (Homebrew).
#
# Usage:
#   chmod +x convert-to-webp.sh
#   ./convert-to-webp.sh [options]
#
# Options:
#   -q <0-100>   Quality (default: 85). Lower = smaller file.
#   -d           Delete originals after successful conversion.
#   -p <path>    Target directory (default: ./images)
#
# Examples:
#   ./convert-to-webp.sh               # quality 85, keep originals
#   ./convert-to-webp.sh -q 75 -d      # quality 75, delete originals
#   ./convert-to-webp.sh -q 90 -p ./my-photos
#
# After running, update your data.json to use .webp filenames.
# ============================================

set -euo pipefail

# ---------- Defaults ----------
QUALITY=85
DELETE_ORIGINALS=false
IMAGES_DIR="./images"

# ---------- Parse flags ----------
while getopts "q:dp:" opt; do
  case $opt in
    q) QUALITY="$OPTARG" ;;
    d) DELETE_ORIGINALS=true ;;
    p) IMAGES_DIR="$OPTARG" ;;
    *) echo "Usage: $0 [-q quality] [-d] [-p path]" >&2; exit 1 ;;
  esac
done

# ---------- Validate quality ----------
if ! [[ "$QUALITY" =~ ^[0-9]+$ ]] || (( QUALITY < 0 || QUALITY > 100 )); then
  echo "❌  Quality must be a number between 0 and 100."
  exit 1
fi

# ---------- Check cwebp ----------
if ! command -v cwebp &>/dev/null; then
  echo "❌  cwebp not found. Install it with:"
  echo "    brew install webp"
  exit 1
fi

# ---------- Check target dir ----------
if [ ! -d "$IMAGES_DIR" ]; then
  echo "❌  Directory not found: $IMAGES_DIR"
  exit 1
fi

# ---------- Counters ----------
COUNT_OK=0
COUNT_SKIP=0
COUNT_FAIL=0
SAVED_BYTES=0

# Helper: human-readable bytes
hr_bytes() {
  local bytes=$1
  if   (( bytes >= 1048576 )); then printf "%.1f MB" "$(echo "scale=1; $bytes/1048576" | bc)"
  elif (( bytes >= 1024 ));    then printf "%.1f KB" "$(echo "scale=1; $bytes/1024"    | bc)"
  else                              printf "%d B" "$bytes"
  fi
}

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   WebP Converter  ·  quality: ${QUALITY}           ║"
echo "╚══════════════════════════════════════════╝"
echo "  Directory  : $IMAGES_DIR"
echo "  Delete src : $DELETE_ORIGINALS"
echo ""

# ---------- Process files ----------
while IFS= read -r -d '' src_file; do
  webp_file="${src_file%.*}.webp"

  # Skip if WebP already exists
  if [ -f "$webp_file" ]; then
    echo "  ⏭  $(basename "$src_file")  →  already converted, skipping"
    COUNT_SKIP=$((COUNT_SKIP + 1))
    continue
  fi

  # Get original size
  orig_size=$(stat -f%z "$src_file" 2>/dev/null || stat --printf="%s" "$src_file" 2>/dev/null || echo 0)

  # Convert
  if cwebp -q "$QUALITY" -mt -preset photo -quiet "$src_file" -o "$webp_file" 2>/dev/null; then
    new_size=$(stat -f%z "$webp_file" 2>/dev/null || stat --printf="%s" "$webp_file" 2>/dev/null || echo 0)
    saved=$(( orig_size - new_size ))
    SAVED_BYTES=$(( SAVED_BYTES + saved ))

    if (( saved >= 0 )); then
      pct=$(( saved * 100 / orig_size ))
      echo "  ✅  $(basename "$src_file")  →  $(basename "$webp_file")"
      echo "      $(hr_bytes "$orig_size")  →  $(hr_bytes "$new_size")  (saved ${pct}%)"
    else
      # WebP ended up larger — still keep it, note it
      echo "  ✅  $(basename "$src_file")  →  $(basename "$webp_file")  ⚠️  (WebP larger by $(hr_bytes $(( -saved ))))"
    fi

    COUNT_OK=$((COUNT_OK + 1))

    # Delete original if flag set
    if [ "$DELETE_ORIGINALS" = true ]; then
      rm "$src_file"
      echo "      🗑  Original deleted."
    fi
  else
    echo "  ❌  Failed to convert: $(basename "$src_file")"
    # Clean up partial output
    [ -f "$webp_file" ] && rm "$webp_file"
    COUNT_FAIL=$((COUNT_FAIL + 1))
  fi

done < <(find "$IMAGES_DIR" -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) -print0 | sort -z)

# ---------- Summary ----------
echo ""
echo "══════════════════════════════════════════"
echo "  ✅  Converted : $COUNT_OK"
echo "  ⏭  Skipped   : $COUNT_SKIP"
echo "  ❌  Failed    : $COUNT_FAIL"
if (( SAVED_BYTES > 0 )); then
  echo "  💾  Total saved : $(hr_bytes "$SAVED_BYTES")"
elif (( COUNT_OK > 0 )); then
  echo "  💾  Net change  : $(hr_bytes $(( -SAVED_BYTES ))) larger"
fi
echo ""

if (( COUNT_OK > 0 )) && [ "$DELETE_ORIGINALS" = false ]; then
  echo "  💡  Originals kept. Run with -d to delete them after verifying."
  echo "  💡  Update data.json file_name fields to use .webp extensions."
fi
echo ""
