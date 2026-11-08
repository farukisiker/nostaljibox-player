#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "Usage: $0 <core> <device-dylib> <sim-dylib> <outdir>" >&2
  exit 1
fi

CORE="$1"
DEVICE_DYLIB="$2"
SIM_DYLIB="$3"
OUTDIR="$4"

if [ ! -f "$DEVICE_DYLIB" ]; then
  echo "ERROR: Device dylib not found: $DEVICE_DYLIB" >&2
  exit 1
fi

if [ ! -f "$SIM_DYLIB" ]; then
  echo "ERROR: Simulator dylib not found: $SIM_DYLIB" >&2
  exit 1
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ios-fw-${CORE}.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

wrap_slice() {
  local slice="$1"
  local src_dylib="$2"
  local supported_platform="$3"
  local dt_platform="$4"
  local expected_vtool_platform="$5"

  local fw_dir="$WORKDIR/$slice/${CORE}.framework"
  mkdir -p "$fw_dir"

  cp "$src_dylib" "$fw_dir/${CORE}"
  chmod 755 "$fw_dir/${CORE}"

  install_name_tool -id "@rpath/${CORE}.framework/${CORE}" "$fw_dir/${CORE}"

  local install_id
  install_id="$(otool -D "$fw_dir/${CORE}" | sed -n '2p' | tr -d '[:space:]')"
  if [ "$install_id" != "@rpath/${CORE}.framework/${CORE}" ]; then
    echo "ERROR: install_name_tool check failed for $slice: got '$install_id'" >&2
    exit 1
  fi

  cat > "$fw_dir/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>${CORE}</string>
  <key>CFBundleIdentifier</key>
  <string>com.nekketsu.soccer.core.${CORE}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${CORE}</string>
  <key>CFBundlePackageType</key>
  <string>FMWK</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>${supported_platform}</string>
  </array>
  <key>DTPlatformName</key>
  <string>${dt_platform}</string>
  <key>MinimumOSVersion</key>
  <string>15.0</string>
</dict>
</plist>
EOF

  plutil -lint "$fw_dir/Info.plist"

  local vtool_out
  vtool_out="$(vtool -show-build "$fw_dir/${CORE}")"
  if ! printf '%s\n' "$vtool_out" | grep -Eq "^[[:space:]]*platform[[:space:]]+${expected_vtool_platform}([[:space:]]|\$)"; then
    echo "ERROR: Framework binary platform mismatch for $slice (expected $expected_vtool_platform)" >&2
    exit 1
  fi
  if ! printf '%s\n' "$vtool_out" | grep -Eq '^[[:space:]]*minos[[:space:]]+15\.0([[:space:]]|$)'; then
    echo "ERROR: Framework binary minos mismatch for $slice (expected 15.0)" >&2
    exit 1
  fi
}

wrap_slice "device" "$DEVICE_DYLIB" "iPhoneOS" "iphoneos" "IOS"
wrap_slice "simulator" "$SIM_DYLIB" "iPhoneSimulator" "iphonesimulator" "IOSSIMULATOR"

mkdir -p "$OUTDIR"
XCF_PATH="$OUTDIR/${CORE}.xcframework"
ZIP_PATH="$OUTDIR/${CORE}.xcframework.zip"
rm -rf "$XCF_PATH" "$ZIP_PATH"

xcodebuild -create-xcframework \
  -framework "$WORKDIR/device/${CORE}.framework" \
  -framework "$WORKDIR/simulator/${CORE}.framework" \
  -output "$XCF_PATH"

ditto -c -k --keepParent "$XCF_PATH" "$ZIP_PATH"

# Verify zip root contains <core>.xcframework/
if ! zipinfo -1 "$ZIP_PATH" | grep -Eq "^${CORE}\.xcframework/"; then
  echo "ERROR: Zip archive $ZIP_PATH does not have ${CORE}.xcframework at root" >&2
  exit 1
fi

CHECKSUM="$(swift package compute-checksum "$ZIP_PATH" | tr -d '[:space:]')"
if [ -z "$CHECKSUM" ]; then
  echo "ERROR: Failed to compute checksum for $ZIP_PATH" >&2
  exit 1
fi

CHECKSUMS_FILE="$OUTDIR/checksums.txt"
if [ -f "$CHECKSUMS_FILE" ]; then
  grep -v "[[:space:]]${CORE}\.xcframework\.zip\$" "$CHECKSUMS_FILE" > "${CHECKSUMS_FILE}.tmp" || true
  mv "${CHECKSUMS_FILE}.tmp" "$CHECKSUMS_FILE"
fi
printf '%s  %s.xcframework.zip\n' "$CHECKSUM" "$CORE" >> "$CHECKSUMS_FILE"

echo "=== Created $ZIP_PATH ==="
echo "  Checksum: $CHECKSUM"
