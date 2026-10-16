#!/usr/bin/env bash
# Re-render the brand images from their HTML sources.
#
# ImageMagick on macOS usually has no fonts registered, so it cannot set type;
# headless Chrome does the typesetting and ImageMagick only quantises the result.
# PNG8 without dithering is deliberate: the dark background gradient mottles
# badly under Floyd-Steinberg, and bands invisibly without it.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../images
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { "$CHROME" --headless --disable-gpu --hide-scrollbars \
  --screenshot="$2" --window-size="$3" --force-device-scale-factor=2 "file://$PWD/$1" 2>/dev/null; }

shot banner.html /tmp/ch-banner.png 1280,320
shot card.html   /tmp/ch-card.png   1200,630
magick /tmp/ch-banner.png +dither -colors 256 -strip "PNG8:$OUT/banner.png"
magick /tmp/ch-card.png -resize 1200x630 +dither -colors 256 -strip "PNG8:$OUT/social-card.png"
echo "wrote $OUT/banner.png and $OUT/social-card.png"
