#!/bin/sh
# 로고 PNG 만들기 (Chrome 헤드리스로 SVG 렌더링 — 그라데이션·둥근 선을 정확히 그림)
#   sh brand/render.sh        → brand/*.png, public/favicon*, android 런처 아이콘
# 필요: Google Chrome (macOS 기본 경로 또는 CHROME 환경변수)
set -e
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# render <svg> <크기> <출력.png>
render() {
  cat > "$TMP/p.html" <<EOF
<!doctype html><html><body style="margin:0;background:transparent"><img src="file://$PWD/$1" width="$2" height="$2" style="display:block"></body></html>
EOF
  "$CHROME" --headless=new --disable-gpu --allow-file-access-from-files --hide-scrollbars \
    --default-background-color=00000000 --window-size="$2,$2" --screenshot="$3" "file://$TMP/p.html" >/dev/null 2>&1
  echo "  $3"
}

# 기본 로고
for s in 1024 512 256 128; do render logo.svg $s "logo-$s.png"; done
# 웹 UI (파비콘은 작은 크기용 단순화 로고)
cp logo-small.svg ../public/favicon.svg
render logo-small.svg 32 ../public/favicon-32.png
render logo.svg 180 ../public/apple-touch-icon.png
# Android 런처 아이콘: 기존형(mipmap, 정사각) + 적응형 전경(108dp 캔버스)
RES=../android/app/src/main/res
for d in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  n=${d%%:*}; rest=${d#*:}; legacy=${rest%%:*}; fg=${rest#*:}
  mkdir -p "$RES/mipmap-$n"
  render logo.svg "$legacy" "$RES/mipmap-$n/ic_launcher.png"
  render logo-foreground.svg "$fg" "$RES/mipmap-$n/ic_launcher_foreground.png"
done
# GitHub 소셜 미리보기 (저장소 Settings → Social preview 에 직접 올림)
"$CHROME" --headless=new --disable-gpu --allow-file-access-from-files --hide-scrollbars \
  --window-size=1280,640 --screenshot=social-preview.png "file://$PWD/social-preview.html" >/dev/null 2>&1
echo "  social-preview.png"
