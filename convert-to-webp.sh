#!/bin/bash
# ============================================
# convert-to-webp.sh — Batch convert images to WebP
# with Automatic EXIF Orientation Correction
# ============================================
#
# Converts all .jpg / .jpeg / .png files under the
# images/ directory to .webp using cwebp (Homebrew)
# and automatically rotates photos upright based on
# their EXIF orientation tag (e.g. smartphone portrait shots).
#
# Usage:
#   chmod +x convert-to-webp.sh
#   ./convert-to-webp.sh [options]
#
# Options:
#   -q <0-100>   Quality (default: 85). Lower = smaller file.
#   -d           Delete originals after successful conversion.
#   -f           Force re-convert even if .webp already exists.
#   -p <path>    Target directory (default: ./images)
#
# Examples:
#   ./convert-to-webp.sh               # quality 85, keep originals
#   ./convert-to-webp.sh -f            # force re-convert to fix rotated images
#   ./convert-to-webp.sh -q 80 -f -p ./images/thanjaur
#
# ============================================

set -euo pipefail

# ---------- Defaults ----------
QUALITY=85
DELETE_ORIGINALS=false
FORCE=false
IMAGES_DIR="./images"

# ---------- Parse flags ----------
while getopts "q:dfp:" opt; do
  case $opt in
    q) QUALITY="$OPTARG" ;;
    d) DELETE_ORIGINALS=true ;;
    f) FORCE=true ;;
    p) IMAGES_DIR="$OPTARG" ;;
    *) echo "Usage: $0 [-q quality] [-d] [-f] [-p path]" >&2; exit 1 ;;
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

# ---------- EXIF Orientation Helper ----------
get_exif_orientation() {
  local file="$1"
  python3 - "$file" << 'EOF' 2>/dev/null || echo 1
import sys, struct
try:
    with open(sys.argv[1], 'rb') as f:
        b = f.read(65536)
    idx = b.find(b'Exif\x00\x00')
    if idx != -1:
        tiff = b[idx+6:]
        if len(tiff) >= 8:
            endian = '<' if tiff[:2] == b'II' else ('>' if tiff[:2] == b'MM' else None)
            if endian:
                offset = struct.unpack(endian + 'I', tiff[4:8])[0]
                entries = struct.unpack(endian + 'H', tiff[offset:offset+2])[0]
                for i in range(entries):
                    entry = tiff[offset+2+i*12:offset+2+(i+1)*12]
                    tag, typ, cnt, val = struct.unpack(endian + 'HHI4s', entry)
                    if tag == 0x0112:
                        print(struct.unpack(endian + 'H', val[:2])[0])
                        sys.exit(0)
except Exception:
    pass
print(1)
EOF
}

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
echo "║   (Auto EXIF Rotation Enabled)           ║"
echo "╚══════════════════════════════════════════╝"
echo "  Directory  : $IMAGES_DIR"
echo "  Force      : $FORCE"
echo "  Delete src : $DELETE_ORIGINALS"
echo ""

# ---------- Process files ----------
while IFS= read -r -d '' src_file; do
  webp_file="${src_file%.*}.webp"

  # Skip if WebP already exists (unless -f is set)
  if [ "$FORCE" = false ] && [ -f "$webp_file" ]; then
    echo "  ⏭  $(basename "$src_file")  →  already converted, skipping"
    COUNT_SKIP=$((COUNT_SKIP + 1))
    continue
  fi

  # Get original size
  orig_size=$(stat -f%z "$src_file" 2>/dev/null || stat --printf="%s" "$src_file" 2>/dev/null || echo 0)

  # Check EXIF orientation and auto-rotate if needed
  orientation=$(get_exif_orientation "$src_file")
  input_for_cwebp="$src_file"
  tmp_rotated=""
  rotation_label=""

  case "$orientation" in
    6)
      tmp_rotated=$(mktemp /tmp/webp_orient_XXXXXX.jpg)
      sips -r 90 "$src_file" --out "$tmp_rotated" >/dev/null 2>&1
      input_for_cwebp="$tmp_rotated"
      rotation_label=" (auto-rotated 90° CW)"
      ;;
    8)
      tmp_rotated=$(mktemp /tmp/webp_orient_XXXXXX.jpg)
      sips -r 270 "$src_file" --out "$tmp_rotated" >/dev/null 2>&1
      input_for_cwebp="$tmp_rotated"
      rotation_label=" (auto-rotated 270° CW)"
      ;;
    3)
      tmp_rotated=$(mktemp /tmp/webp_orient_XXXXXX.jpg)
      sips -r 180 "$src_file" --out "$tmp_rotated" >/dev/null 2>&1
      input_for_cwebp="$tmp_rotated"
      rotation_label=" (auto-rotated 180°)"
      ;;
    *)
      # Upright (orientation 1, 0, or none)
      ;;
  esac

  # Convert with cwebp
  if cwebp -q "$QUALITY" -mt -preset photo -quiet "$input_for_cwebp" -o "$webp_file" 2>/dev/null; then
    new_size=$(stat -f%z "$webp_file" 2>/dev/null || stat --printf="%s" "$webp_file" 2>/dev/null || echo 0)
    saved=$(( orig_size - new_size ))
    SAVED_BYTES=$(( SAVED_BYTES + saved ))

    if (( saved >= 0 )); then
      pct=$(( saved * 100 / orig_size ))
      echo "  ✅  $(basename "$src_file")  →  $(basename "$webp_file")${rotation_label}"
      echo "      $(hr_bytes "$orig_size")  →  $(hr_bytes "$new_size")  (saved ${pct}%)"
    else
      echo "  ✅  $(basename "$src_file")  →  $(basename "$webp_file")${rotation_label}"
      echo "      $(hr_bytes "$orig_size")  →  $(hr_bytes "$new_size")  ⚠️  (WebP larger by $(hr_bytes $(( -saved ))))"
    fi

    COUNT_OK=$((COUNT_OK + 1))

    # Delete original if flag set
    if [ "$DELETE_ORIGINALS" = true ]; then
      rm "$src_file"
      echo "      🗑  Original deleted."
    fi
  else
    echo "  ❌  Failed to convert: $(basename "$src_file")"
    [ -f "$webp_file" ] && rm -f "$webp_file"
    COUNT_FAIL=$((COUNT_FAIL + 1))
  fi

  # Clean up temp rotated file
  if [ -n "$tmp_rotated" ] && [ -f "$tmp_rotated" ]; then
    rm -f "$tmp_rotated"
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
