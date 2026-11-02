#!/bin/zsh
# build.sh — builds "NAZAR Console.app" (Apple Silicon + Intel, macOS 12+) into ../build, plus a zip for teammates.
# Needs only the Xcode Command Line Tools (xcode-select --install). No Xcode project.
#   cd app && ./build.sh
set -euo pipefail
cd "${0:A:h}"

NAME="NAZAR Console"
EXE="NAZARConsole"
BUNDLE_ID="com.teamparakh.nazar-console"
VERSION="2.0.0"
OUT="../build"
APP="$OUT/$NAME.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "• compiling Swift (arm64 + x86_64)"
for arch in arm64 x86_64; do
  swiftc -O -warnings-as-errors -target "$arch-apple-macos12.0" -module-name NAZARConsole \
    -o "$TMP/$EXE-$arch" Sources/*.swift
done
lipo -create -output "$APP/Contents/MacOS/$EXE" "$TMP/$EXE-arm64" "$TMP/$EXE-x86_64"

echo "• icon"
swift make_icon.swift assets/eye-white-1024.png "$TMP/icon.png"
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
cp "$TMP/icon.png" "$OUT/icon-1024.png"

echo "• screen (web/)"
rsync -a --delete --exclude '.DS_Store' ../web/ "$APP/Contents/Resources/web/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>$EXE</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSCameraUsageDescription</key><string>NAZAR Console photographs each washer on the inspection line.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSHumanReadableCopyright</key><string>Team Parakh · NAZAR · INDUX 5.0</string>
</dict>
</plist>
PLIST

echo "• signing (ad-hoc, requirement = bundle id, so the camera permission survives rebuilds)"
codesign --force --deep --sign - -r="designated => identifier \"$BUNDLE_ID\"" "$APP"

echo "• zip"
rm -f "$OUT/NAZAR-Console-mac.zip"
ditto -c -k --keepParent "$APP" "$OUT/NAZAR-Console-mac.zip"

echo "done: ${APP:A}"
