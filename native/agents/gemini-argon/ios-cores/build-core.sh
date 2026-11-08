#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 <core> <device|simulator> <outdir>" >&2
  exit 1
fi

CORE="$1"
SLICE="$2"
OUTDIR="$3"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="$SCRIPT_DIR/cores.lock.json"

if [ ! -f "$LOCK_FILE" ]; then
  echo "ERROR: Lock file not found at $LOCK_FILE" >&2
  exit 1
fi

case "$SLICE" in
  device)
    SDK="iphoneos"
    TARGET="arm64-apple-ios15.0"
    MINVER_FLAG="-miphoneos-version-min=15.0"
    EXPECTED_PLATFORM="IOS"
    ;;
  simulator)
    SDK="iphonesimulator"
    TARGET="arm64-apple-ios15.0-simulator"
    MINVER_FLAG="-mios-simulator-version-min=15.0"
    EXPECTED_PLATFORM="IOSSIMULATOR"
    ;;
  *)
    echo "ERROR: Invalid slice '$SLICE' (expected 'device' or 'simulator')" >&2
    exit 1
    ;;
esac

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ios-core-${CORE}-${SLICE}.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

python3 - "$LOCK_FILE" "$CORE" > "$WORKDIR/meta.sh" <<'PY'
import json, shlex, sys

lock_path, core = sys.argv[1], sys.argv[2]
with open(lock_path, "r", encoding="utf-8") as f:
    data = json.load(f)

if core not in data:
    sys.stderr.write(f"ERROR: Core '{core}' not found in {lock_path}\n")
    sys.exit(1)

entry = data[core]
print(f"REPO={shlex.quote(entry['repo'])}")
print(f"COMMIT={shlex.quote(entry['commit'])}")
print(f"SUBDIR={shlex.quote(entry.get('dir', '.'))}")
print(f"MAKEFILE={shlex.quote(entry.get('makefile', 'Makefile'))}")
print(f"OUTPUT_NAME={shlex.quote(entry['output'])}")
print(f"MAKE_PLATFORM={shlex.quote(entry.get('platform', 'ios-arm64'))}")
args = entry.get("args", [])
quoted_args = " ".join(shlex.quote(a) for a in args)
print(f"EXTRA_ARGS=({quoted_args})")
PY

# shellcheck disable=SC1091
source "$WORKDIR/meta.sh"

SDKPATH="$(xcrun --sdk "$SDK" --show-sdk-path)"
echo "=== Building $CORE ($SLICE) ==="
echo "  Repo:     $REPO @ $COMMIT"
echo "  SDK:      $SDK ($SDKPATH)"
echo "  Target:   $TARGET"

mkdir -p "$WORKDIR/src"
git -C "$WORKDIR/src" init -q
git -C "$WORKDIR/src" remote add origin "$REPO"
if ! git -C "$WORKDIR/src" fetch --depth 1 origin "$COMMIT"; then
  rm -rf "$WORKDIR/src"
  git clone "$REPO" "$WORKDIR/src"
fi
git -C "$WORKDIR/src" checkout -q "$COMMIT"

ACTUAL_COMMIT="$(git -C "$WORKDIR/src" rev-parse HEAD)"
if [ "$ACTUAL_COMMIT" != "$COMMIT" ]; then
  echo "ERROR: Checked out commit $ACTUAL_COMMIT does not match pinned $COMMIT" >&2
  exit 1
fi

PATCH_FILE="$SCRIPT_DIR/patches/${CORE}.patch"
if [ -f "$PATCH_FILE" ]; then
  echo "Applying patch $PATCH_FILE..."
  git -C "$WORKDIR/src" apply "$PATCH_FILE"
fi

BUILD_DIR="$WORKDIR/src/$SUBDIR"
COMMON_FLAGS="-target $TARGET -arch arm64 -isysroot $SDKPATH $MINVER_FLAG"
CC_CMD="xcrun -sdk $SDK clang $COMMON_FLAGS"
CXX_CMD="xcrun -sdk $SDK clang++ $COMMON_FLAGS"

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

CFLAGS="$COMMON_FLAGS" \
CXXFLAGS="$COMMON_FLAGS" \
LDFLAGS="$COMMON_FLAGS" \
make -C "$BUILD_DIR" -f "$MAKEFILE" -j"$JOBS" \
  platform="$MAKE_PLATFORM" \
  IOSSDK="$SDKPATH" \
  CC="$CC_CMD" \
  CXX="$CXX_CMD" \
  IPHONEMINVER="-target $TARGET $MINVER_FLAG" \
  MINVERSION="-target $TARGET $MINVER_FLAG" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

BUILT_DYLIB="$BUILD_DIR/$OUTPUT_NAME"
if [ ! -f "$BUILT_DYLIB" ]; then
  echo "ERROR: Expected output dylib not found at $BUILT_DYLIB" >&2
  exit 1
fi

echo "=== Verifying $BUILT_DYLIB ($SLICE) ==="

echo "--- vtool -show-build ---"
VTOOL_OUT="$(vtool -show-build "$BUILT_DYLIB")"
echo "$VTOOL_OUT"

PLATFORM_COUNT="$(printf '%s\n' "$VTOOL_OUT" | grep -Ec '^[[:space:]]*platform[[:space:]]+' || true)"
if [ "$PLATFORM_COUNT" -ne 1 ]; then
  echo "ERROR: Expected exactly 1 platform entry in vtool output, got $PLATFORM_COUNT" >&2
  exit 1
fi

if ! printf '%s\n' "$VTOOL_OUT" | grep -Eq "^[[:space:]]*platform[[:space:]]+${EXPECTED_PLATFORM}([[:space:]]|\$)"; then
  echo "ERROR: vtool platform check failed: expected platform $EXPECTED_PLATFORM" >&2
  exit 1
fi

if ! printf '%s\n' "$VTOOL_OUT" | grep -Eq '^[[:space:]]*minos[[:space:]]+15\.0([[:space:]]|$)'; then
  echo "ERROR: vtool minos check failed: expected minos 15.0" >&2
  exit 1
fi

echo "--- lipo -info ---"
LIPO_INFO="$(lipo -info "$BUILT_DYLIB")"
echo "$LIPO_INFO"
LIPO_ARCHS="$(lipo -archs "$BUILT_DYLIB")"
if [ "$LIPO_ARCHS" != "arm64" ]; then
  echo "ERROR: lipo architecture check failed: expected 'arm64' only, got '$LIPO_ARCHS'" >&2
  exit 1
fi

echo "--- otool -L ---"
OTOOL_OUT="$(otool -L "$BUILT_DYLIB")"
echo "$OTOOL_OUT"

python3 - "$BUILT_DYLIB" "$OTOOL_OUT" <<'PY'
import subprocess, sys

dylib_path, otool_out = sys.argv[1], sys.argv[2]
id_out = subprocess.check_output(["otool", "-D", dylib_path], text=True).splitlines()
self_id = id_out[1].strip() if len(id_out) > 1 else ""

lines = [line.strip() for line in otool_out.splitlines()[1:] if line.strip()]
deps = []
for line in lines:
    lib = line.split(" (", 1)[0].strip()
    if lib == self_id:
        continue
    deps.append(lib)

if not deps:
    sys.stderr.write("ERROR: No linked system libraries found in otool -L output\n")
    sys.exit(1)

bad = [d for d in deps if not (d.startswith("/usr/lib/") or d.startswith("/System/"))]
if bad:
    sys.stderr.write(f"ERROR: Disallowed linked libraries in {dylib_path}: {bad}\n")
    sys.exit(1)

print(f"Verified linked libraries: {deps}")
PY

mkdir -p "$OUTDIR"
cp "$BUILT_DYLIB" "$OUTDIR/${CORE}.dylib"
cp "$BUILT_DYLIB" "$OUTDIR/${CORE}-${SLICE}.dylib"
echo "=== Built and verified $OUTDIR/${CORE}.dylib ($SLICE) ==="
