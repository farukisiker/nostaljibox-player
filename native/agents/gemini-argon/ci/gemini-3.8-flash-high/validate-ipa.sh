#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# validate-ipa.sh - Exported-IPA & Framework Validation Gate
#
# Usage:
#   validate-ipa.sh <path-to.ipa>
#   validate-ipa.sh --framework <path.framework> [--min-os <version>]
#
# Bash 3.2 compatible, macOS CLI tools (unzip, ditto, vtool, lipo, otool,
# plutil, /usr/libexec/PlistBuddy, codesign, python3).
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_LOCK_JSON="$(cd "$SCRIPT_DIR/../.." && pwd)/ios-cores/cores.lock.json"
CORES_LOCK_JSON="${CORES_LOCK_JSON:-$DEFAULT_LOCK_JSON}"

MODE=""
IPA_PATH=""
FRAMEWORK_PATH=""
APP_MIN_OS=""
UNZIP_DIR=""
TOTAL_FAILURES=0

# Summary table accumulator (Bash 3.2 indexed array)
TABLE_ROWS=()

record_result() {
  local target="$1"
  local check="$2"
  local status="$3"
  local details="$4"
  # Replace any pipe characters to avoid corrupting Markdown table columns
  local safe_details
  safe_details="$(printf '%s' "$details" | tr '|' '/')"
  TABLE_ROWS[${#TABLE_ROWS[@]}]="| $target | $check | $status | $safe_details |"
  if [ "$status" != "PASS" ]; then
    TOTAL_FAILURES=$((TOTAL_FAILURES + 1))
  fi
}

print_summary_table() {
  echo ""
  echo "=== Validation Gate Summary ==="
  echo "| Target | Check | Status | Details |"
  echo "|---|---|---|---|"
  local i=0
  while [ $i -lt ${#TABLE_ROWS[@]} ]; do
    echo "${TABLE_ROWS[$i]}"
    i=$((i + 1))
  done
  echo ""
}

cleanup() {
  if [ -n "$UNZIP_DIR" ] && [ -d "$UNZIP_DIR" ]; then
    rm -rf "$UNZIP_DIR"
  fi
}
trap cleanup EXIT

usage() {
  cat <<EOF
Usage:
  $(basename "$0") <path-to.ipa>
  $(basename "$0") --framework <path.framework> [--min-os <version>]

Modes:
  1. IPA Mode:
     $(basename "$0") <path-to.ipa>
     Unzips IPA, verifies Payload/App.app, validates all cores from cores.lock.json,
     and verifies codesign deep strict signature.

  2. Framework Self-Test Mode:
     $(basename "$0") --framework <path.framework> [--min-os <version>]
     Validates a single core framework slice directly (skips codesign).

Options:
  --framework, -f <path>  Path to .framework directory for self-test mode.
  --min-os <version>      Override app MinimumOSVersion (defaults to 15.0 or Info.plist value).
  -h, --help              Show this help message.

Environment:
  CORES_LOCK_JSON         Path to cores.lock.json (defaults to relative path ../../ios-cores/cores.lock.json).
EOF
}

# Resolve working python interpreter (prefer python3, fallback to python)
PYTHON_BIN=""
if python3 -c "import sys" >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif python -c "import sys" >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "ERROR: Neither python3 nor python is functional in PATH" >&2
  exit 1
fi

# ==============================================================================
# CLI Argument Parsing
# ==============================================================================

while [ "$#" -gt 0 ]; do
  case "$1" in
    --framework|-f)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --framework requires a path argument" >&2
        usage
        exit 1
      fi
      MODE="framework"
      FRAMEWORK_PATH="$2"
      shift 2
      ;;
    --min-os)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --min-os requires a version argument" >&2
        usage
        exit 1
      fi
      APP_MIN_OS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [ -z "$IPA_PATH" ] && [ -z "$MODE" ]; then
        MODE="ipa"
        IPA_PATH="$1"
        shift
      else
        echo "ERROR: Unexpected argument: $1" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "ERROR: Missing required arguments. Provide an IPA path or --framework <path.framework>" >&2
  usage
  exit 1
fi

# Ensure cores.lock.json exists
if [ ! -f "$CORES_LOCK_JSON" ]; then
  echo "ERROR: cores.lock.json not found at $CORES_LOCK_JSON" >&2
  exit 1
fi

# Read core names from cores.lock.json
CORES_LIST="$("$PYTHON_BIN" -c "
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        data = json.load(f)
    print('\n'.join(data.keys()))
except Exception as e:
    sys.stderr.write(f'Failed to parse lockfile: {e}\n')
    sys.exit(1)
" "$CORES_LOCK_JSON" | tr -d '\r')"

# ==============================================================================
# Per-Framework Validation Checks
# ==============================================================================

# Check 1: Executable & CFBundleExecutable
# - <fw_path>/Info.plist exists and passes plutil -lint
# - CFBundleExecutable in Info.plist equals <core>
# - Executable file <fw_path>/<core> exists and is non-empty
validate_check1() {
  local fw_path="$1"
  local core="$2"
  local check_name="Executable & CFBundleExecutable"
  local errors=()

  local plist="$fw_path/Info.plist"
  if [ ! -f "$plist" ]; then
    errors[${#errors[@]}]="Info.plist does not exist"
  else
    if command -v plutil >/dev/null 2>&1; then
      if ! plutil -lint "$plist" >/dev/null 2>&1; then
        errors[${#errors[@]}]="plutil -lint failed for Info.plist"
      fi
    fi

    local exec_name
    exec_name="$("$PYTHON_BIN" -c "
import plistlib, sys
try:
    with open(sys.argv[1], 'rb') as f:
        d = plistlib.load(f)
    print(d.get('CFBundleExecutable', ''))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
" "$plist" 2>/dev/null | tr -d '\r' || true)"

    if [ -z "$exec_name" ]; then
      errors[${#errors[@]}]="CFBundleExecutable is missing from Info.plist"
    elif [ "$exec_name" != "$core" ]; then
      errors[${#errors[@]}]="CFBundleExecutable is '$exec_name', expected '$core'"
    fi
  fi

  local bin="$fw_path/$core"
  if [ ! -f "$bin" ]; then
    errors[${#errors[@]}]="Executable binary '$bin' does not exist"
  elif [ ! -s "$bin" ]; then
    errors[${#errors[@]}]="Executable binary '$bin' is empty (0 bytes)"
  fi

  if [ ${#errors[@]} -eq 0 ]; then
    record_result "$core" "$check_name" "PASS" "CFBundleExecutable=$core, binary exists and non-empty"
    return 0
  else
    local err_summary=""
    local idx=0
    while [ $idx -lt ${#errors[@]} ]; do
      local err="${errors[$idx]}"
      [ -n "$err_summary" ] && err_summary="$err_summary; "
      err_summary="$err_summary$err"
      echo "[ERROR] $core ($check_name): $err" >&2
      idx=$((idx + 1))
    done
    record_result "$core" "$check_name" "FAIL" "$err_summary"
    return 1
  fi
}

# Check 2: vtool -show-build Platform & minos
# - Reports platform IOS (specifically IOS, NOT IOSSIMULATOR)
# - Reports minos <ver> where <ver> <= <app MinimumOSVersion>
validate_check2() {
  local fw_path="$1"
  local core="$2"
  local app_min_os="$3"
  local check_name="vtool Platform & minos"
  local bin="$fw_path/$core"
  local errors=()

  if [ ! -f "$bin" ]; then
    record_result "$core" "$check_name" "FAIL" "Binary '$bin' not found"
    echo "[ERROR] $core ($check_name): Binary '$bin' not found" >&2
    return 1
  fi

  if ! command -v vtool >/dev/null 2>&1; then
    record_result "$core" "$check_name" "FAIL" "vtool command not found in PATH"
    echo "[ERROR] $core ($check_name): vtool command not found in PATH" >&2
    return 1
  fi

  local vtool_out
  local vtool_status=0
  vtool_out="$(vtool -show-build "$bin" 2>&1)" || vtool_status=$?
  if [ $vtool_status -ne 0 ]; then
    record_result "$core" "$check_name" "FAIL" "vtool -show-build failed: $vtool_out"
    echo "[ERROR] $core ($check_name): vtool -show-build failed: $vtool_out" >&2
    return 1
  fi

  # Parse platforms
  local platforms
  platforms="$(printf '%s\n' "$vtool_out" | tr -d '\r' | awk '$1 == "platform" { print $2 }')"
  if [ -z "$platforms" ]; then
    errors[${#errors[@]}]="No platform field reported by vtool -show-build"
  else
    local p
    local found_ios=0
    for p in $platforms; do
      if [ "$p" = "IOS" ]; then
        found_ios=1
      elif [ "$p" = "IOSSIMULATOR" ]; then
        errors[${#errors[@]}]="Found simulator platform 'IOSSIMULATOR' (expected 'IOS' only)"
      else
        errors[${#errors[@]}]="Unexpected platform '$p' (expected 'IOS' only)"
      fi
    done
    if [ $found_ios -eq 0 ] && [ ${#errors[@]} -eq 0 ]; then
      errors[${#errors[@]}]="Platform 'IOS' not reported"
    fi
  fi

  # Parse minos
  local minos_list
  minos_list="$(printf '%s\n' "$vtool_out" | tr -d '\r' | awk '$1 == "minos" { print $2 }')"
  if [ -z "$minos_list" ]; then
    errors[${#errors[@]}]="No minos field reported by vtool -show-build"
  else
    local m
    for m in $minos_list; do
      local cmp_status=0
      "$PYTHON_BIN" -c "
import sys
def parse_ver(v):
    return [int(x) for x in v.strip().split('.') if x.isdigit()]
p1 = parse_ver(sys.argv[1])
p2 = parse_ver(sys.argv[2])
maxlen = max(len(p1), len(p2))
p1 += [0] * (maxlen - len(p1))
p2 += [0] * (maxlen - len(p2))
sys.exit(0 if p1 <= p2 else 1)
" "$m" "$app_min_os" 2>/dev/null || cmp_status=$?
      if [ $cmp_status -ne 0 ]; then
        errors[${#errors[@]}]="Binary minos ($m) > app MinimumOSVersion ($app_min_os)"
      fi
    done
  fi

  if [ ${#errors[@]} -eq 0 ]; then
    local minos_summary
    minos_summary="$(printf '%s' "$minos_list" | tr '\n' ' ' | awk '{$1=$1};1')"
    record_result "$core" "$check_name" "PASS" "platform=IOS, minos=$minos_summary <= $app_min_os"
    return 0
  else
    local err_summary=""
    local idx=0
    while [ $idx -lt ${#errors[@]} ]; do
      local err="${errors[$idx]}"
      [ -n "$err_summary" ] && err_summary="$err_summary; "
      err_summary="$err_summary$err"
      echo "[ERROR] $core ($check_name): $err" >&2
      idx=$((idx + 1))
    done
    record_result "$core" "$check_name" "FAIL" "$err_summary"
    return 1
  fi
}

# Check 3: lipo -info Architecture
# - Reports architecture arm64 only (no x86_64, no simulator slice)
validate_check3() {
  local fw_path="$1"
  local core="$2"
  local check_name="lipo Architecture"
  local bin="$fw_path/$core"

  if [ ! -f "$bin" ]; then
    record_result "$core" "$check_name" "FAIL" "Binary '$bin' not found"
    echo "[ERROR] $core ($check_name): Binary '$bin' not found" >&2
    return 1
  fi

  if ! command -v lipo >/dev/null 2>&1; then
    record_result "$core" "$check_name" "FAIL" "lipo command not found in PATH"
    echo "[ERROR] $core ($check_name): lipo command not found in PATH" >&2
    return 1
  fi

  local lipo_out
  local lipo_status=0
  lipo_out="$(lipo -info "$bin" 2>&1)" || lipo_status=$?
  if [ $lipo_status -ne 0 ]; then
    record_result "$core" "$check_name" "FAIL" "lipo -info failed: $lipo_out"
    echo "[ERROR] $core ($check_name): lipo -info failed: $lipo_out" >&2
    return 1
  fi

  # Output formats:
  # "Non-fat file: <path> is architecture: arm64"
  # "Architectures in the fat file: <path> are: arm64"
  # "Architectures in the fat file: <path> are: arm64 x86_64"
  local arch_list
  arch_list="$(printf '%s\n' "$lipo_out" | tr -d '\r' | sed -e 's/.*are:[[:space:]]*//' -e 's/.*is architecture:[[:space:]]*//' | tr '\n' ' ' | awk '{$1=$1};1')"

  if [ "$arch_list" = "arm64" ]; then
    record_result "$core" "$check_name" "PASS" "arm64 only"
    return 0
  else
    local err="lipo reported architecture '$arch_list', expected 'arm64' only"
    record_result "$core" "$check_name" "FAIL" "$err"
    echo "[ERROR] $core ($check_name): $err" >&2
    return 1
  fi
}

# Check 4: otool -D Install Name
# - otool -D install ID (line 2 trimmed) equals @rpath/<core>.framework/<core>
validate_check4() {
  local fw_path="$1"
  local core="$2"
  local check_name="otool -D Install Name"
  local bin="$fw_path/$core"
  local expected_id="@rpath/${core}.framework/${core}"

  if [ ! -f "$bin" ]; then
    record_result "$core" "$check_name" "FAIL" "Binary '$bin' not found"
    echo "[ERROR] $core ($check_name): Binary '$bin' not found" >&2
    return 1
  fi

  if ! command -v otool >/dev/null 2>&1; then
    record_result "$core" "$check_name" "FAIL" "otool command not found in PATH"
    echo "[ERROR] $core ($check_name): otool command not found in PATH" >&2
    return 1
  fi

  local otool_out
  local otool_status=0
  otool_out="$(otool -D "$bin" 2>&1)" || otool_status=$?
  if [ $otool_status -ne 0 ]; then
    record_result "$core" "$check_name" "FAIL" "otool -D failed: $otool_out"
    echo "[ERROR] $core ($check_name): otool -D failed: $otool_out" >&2
    return 1
  fi

  local install_id
  install_id="$(printf '%s\n' "$otool_out" | sed -n '2p' | tr -d '[:space:]')"

  if [ "$install_id" = "$expected_id" ]; then
    record_result "$core" "$check_name" "PASS" "$install_id"
    return 0
  else
    local err="Install name is '$install_id', expected '$expected_id'"
    record_result "$core" "$check_name" "FAIL" "$err"
    echo "[ERROR] $core ($check_name): $err" >&2
    return 1
  fi
}

# Check 5: otool -L System Libraries Only
# - In otool -L lines 2+ with (compatibility version ...) stripped and trimmed:
# - Every entry is either @rpath/<core>.framework/<core> (its own install ID)
#   OR starts with /usr/lib/ or /System/Library/Frameworks/
# - Any other @rpath/, @loader_path/, @executable_path/, /opt/, or /usr/local/ is a failure
validate_check5() {
  local fw_path="$1"
  local core="$2"
  local check_name="otool -L System Libraries"
  local bin="$fw_path/$core"
  local own_id="@rpath/${core}.framework/${core}"

  if [ ! -f "$bin" ]; then
    record_result "$core" "$check_name" "FAIL" "Binary '$bin' not found"
    echo "[ERROR] $core ($check_name): Binary '$bin' not found" >&2
    return 1
  fi

  if ! command -v otool >/dev/null 2>&1; then
    record_result "$core" "$check_name" "FAIL" "otool command not found in PATH"
    echo "[ERROR] $core ($check_name): otool command not found in PATH" >&2
    return 1
  fi

  local otool_out
  local otool_status=0
  otool_out="$(otool -L "$bin" 2>&1)" || otool_status=$?
  if [ $otool_status -ne 0 ]; then
    record_result "$core" "$check_name" "FAIL" "otool -L failed: $otool_out"
    echo "[ERROR] $core ($check_name): otool -L failed: $otool_out" >&2
    return 1
  fi

  # Lines 2+ stripped of (compatibility version ...) and whitespace
  local libs
  libs="$(printf '%s\n' "$otool_out" | tr -d '\r' | sed '1d' | sed -e 's/[[:space:]]*(compatibility version.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$' || true)"

  if [ -z "$libs" ]; then
    record_result "$core" "$check_name" "FAIL" "No dependencies found in otool -L output"
    echo "[ERROR] $core ($check_name): No dependencies found in otool -L output" >&2
    return 1
  fi

  local invalid_libs=()
  local valid_count=0
  local line

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      "$own_id")
        valid_count=$((valid_count + 1))
        ;;
      /usr/lib/*)
        valid_count=$((valid_count + 1))
        ;;
      /System/Library/Frameworks/*)
        valid_count=$((valid_count + 1))
        ;;
      *)
        invalid_libs[${#invalid_libs[@]}]="$line"
        ;;
    esac
  done <<EOF
$libs
EOF

  if [ ${#invalid_libs[@]} -eq 0 ]; then
    record_result "$core" "$check_name" "PASS" "All $valid_count dependencies valid (own ID or system)"
    return 0
  else
    local err_summary=""
    local idx=0
    while [ $idx -lt ${#invalid_libs[@]} ]; do
      local inv="${invalid_libs[$idx]}"
      [ -n "$err_summary" ] && err_summary="$err_summary; "
      err_summary="$err_summary$inv"
      echo "[ERROR] $core ($check_name): Disallowed dependency: $inv" >&2
      idx=$((idx + 1))
    done
    record_result "$core" "$check_name" "FAIL" "Disallowed dependencies: $err_summary"
    return 1
  fi
}

# Check 6: Info.plist Required Keys
# - CFBundlePackageType == FMWK
# - CFBundleIdentifier is non-empty
# - CFBundleVersion is non-empty
# - CFBundleShortVersionString is non-empty
# - CFBundleSupportedPlatforms is a list containing only iPhoneOS (["iPhoneOS"])
# - MinimumOSVersion is non-empty and <= <app MinimumOSVersion>
validate_check6() {
  local fw_path="$1"
  local core="$2"
  local app_min_os="$3"
  local check_name="Info.plist Required Keys"
  local plist="$fw_path/Info.plist"

  if [ ! -f "$plist" ]; then
    record_result "$core" "$check_name" "FAIL" "Info.plist does not exist"
    echo "[ERROR] $core ($check_name): Info.plist does not exist" >&2
    return 1
  fi

  local py_output
  local py_status=0
  py_output="$("$PYTHON_BIN" -c "
import plistlib, sys

plist_path = sys.argv[1]
app_min_os = sys.argv[2]
errors = []

try:
    with open(plist_path, 'rb') as f:
        data = plistlib.load(f)
except Exception as e:
    sys.stderr.write(f'Failed to parse plist: {e}\n')
    sys.exit(1)

# 1. CFBundlePackageType == FMWK
pkg_type = data.get('CFBundlePackageType')
if pkg_type != 'FMWK':
    errors.append(f\"CFBundlePackageType is {repr(pkg_type)}, expected 'FMWK'\")

# 2. CFBundleIdentifier non-empty
bundle_id = data.get('CFBundleIdentifier')
if not bundle_id or not str(bundle_id).strip():
    errors.append('CFBundleIdentifier is missing or empty')

# 3. CFBundleVersion non-empty
bundle_ver = data.get('CFBundleVersion')
if not bundle_ver or not str(bundle_ver).strip():
    errors.append('CFBundleVersion is missing or empty')

# 4. CFBundleShortVersionString non-empty
short_ver = data.get('CFBundleShortVersionString')
if not short_ver or not str(short_ver).strip():
    errors.append('CFBundleShortVersionString is missing or empty')

# 5. CFBundleSupportedPlatforms is [\"iPhoneOS\"]
platforms = data.get('CFBundleSupportedPlatforms')
if not isinstance(platforms, list):
    errors.append(f'CFBundleSupportedPlatforms is not a list (got {type(platforms).__name__})')
elif platforms != ['iPhoneOS']:
    errors.append(f'CFBundleSupportedPlatforms is {platforms}, expected [\"iPhoneOS\"]')

# 6. MinimumOSVersion is non-empty and <= app MinimumOSVersion
min_os = data.get('MinimumOSVersion')
if not min_os or not str(min_os).strip():
    errors.append('MinimumOSVersion is missing or empty')
else:
    min_os_str = str(min_os).strip()
    def parse_ver(v):
        return [int(x) for x in v.split('.') if x.isdigit()]
    v_fw = parse_ver(min_os_str)
    v_app = parse_ver(app_min_os)
    maxlen = max(len(v_fw), len(v_app))
    v_fw += [0] * (maxlen - len(v_fw))
    v_app += [0] * (maxlen - len(v_app))
    if v_fw > v_app:
        errors.append(f'MinimumOSVersion ({min_os_str}) > app MinimumOSVersion ({app_min_os})')

if errors:
    for e in errors:
        sys.stderr.write(e + '\n')
    sys.exit(1)
else:
    print(f'FMWK, id={bundle_id}, v={short_ver}({bundle_ver}), [iPhoneOS], minos={min_os} <= {app_min_os}')
    sys.exit(0)
" "$plist" "$app_min_os" 2>&1)" || py_status=$?

  if [ $py_status -eq 0 ]; then
    record_result "$core" "$check_name" "PASS" "$py_output"
    return 0
  else
    local err_summary=""
    while IFS= read -r line; do
      line="$(printf '%s' "$line" | tr -d '\r')"
      [ -z "$line" ] && continue
      [ -n "$err_summary" ] && err_summary="$err_summary; "
      err_summary="$err_summary$line"
      echo "[ERROR] $core ($check_name): $line" >&2
    done <<EOF
$py_output
EOF
    record_result "$core" "$check_name" "FAIL" "$err_summary"
    return 1
  fi
}

# ==============================================================================
# Codesign Verification Check (IPA Mode only)
# ==============================================================================

validate_codesign() {
  local app_bundle="$1"
  local app_name
  app_name="$(basename "$app_bundle")"
  local check_name="codesign --verify"

  if ! command -v codesign >/dev/null 2>&1; then
    record_result "$app_name" "$check_name" "FAIL" "codesign command not found in PATH"
    echo "[ERROR] $app_name ($check_name): codesign command not found in PATH" >&2
    return 1
  fi

  local codesign_out
  local codesign_status=0
  codesign_out="$(codesign --verify --deep --strict --verbose=2 "$app_bundle" 2>&1)" || codesign_status=$?

  if [ $codesign_status -eq 0 ]; then
    record_result "$app_name" "$check_name" "PASS" "valid signature (--deep --strict)"
    return 0
  else
    record_result "$app_name" "$check_name" "FAIL" "codesign verification failed"
    echo "[ERROR] $app_name ($check_name): codesign verification failed:" >&2
    printf '%s\n' "$codesign_out" >&2
    return 1
  fi
}

# ==============================================================================
# Runner Modes
# ==============================================================================

run_framework_mode() {
  local fw_path="$FRAMEWORK_PATH"

  if [ ! -d "$fw_path" ]; then
    echo "ERROR: Framework directory not found: $fw_path" >&2
    exit 1
  fi

  local core
  core="$(basename "$fw_path")"
  core="${core%.framework}"

  APP_MIN_OS="${APP_MIN_OS:-15.0}"

  # Verify core is listed in cores.lock.json
  local is_known_core
  is_known_core="$("$PYTHON_BIN" -c "
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        d = json.load(f)
    print('YES' if sys.argv[2] in d else 'NO')
except Exception:
    print('NO')
" "$CORES_LOCK_JSON" "$core" 2>/dev/null | tr -d '[:space:]' || echo "NO")"

  if [ "$is_known_core" != "YES" ]; then
    record_result "$core" "Lockfile Membership" "FAIL" "Core '$core' not in cores.lock.json"
    echo "[ERROR] Core '$core' is not listed in $CORES_LOCK_JSON" >&2
  else
    record_result "$core" "Lockfile Membership" "PASS" "Listed in cores.lock.json"
  fi

  echo "Validating framework $fw_path (core: $core, target min-os: $APP_MIN_OS)..."

  # Run all 6 per-framework checks (codesign skipped in --framework mode)
  validate_check1 "$fw_path" "$core" || true
  validate_check2 "$fw_path" "$core" "$APP_MIN_OS" || true
  validate_check3 "$fw_path" "$core" || true
  validate_check4 "$fw_path" "$core" || true
  validate_check5 "$fw_path" "$core" || true
  validate_check6 "$fw_path" "$core" "$APP_MIN_OS" || true
}

run_ipa_mode() {
  local ipa="$IPA_PATH"

  if [ ! -f "$ipa" ]; then
    echo "ERROR: IPA file not found: $ipa" >&2
    exit 1
  fi

  UNZIP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/validate-ipa.XXXXXX")"

  # Unzip archive
  if command -v unzip >/dev/null 2>&1; then
    if ! unzip -q "$ipa" -d "$UNZIP_DIR"; then
      echo "ERROR: Failed to unzip $ipa with unzip" >&2
      exit 1
    fi
  elif command -v ditto >/dev/null 2>&1; then
    if ! ditto -x -k "$ipa" "$UNZIP_DIR"; then
      echo "ERROR: Failed to unzip $ipa with ditto" >&2
      exit 1
    fi
  else
    echo "ERROR: Neither unzip nor ditto found in PATH" >&2
    exit 1
  fi

  # Verify Payload/App.app exists
  local app_bundle="$UNZIP_DIR/Payload/App.app"
  if [ ! -d "$app_bundle" ]; then
    record_result "Payload/App.app" "App Bundle Present" "FAIL" "Payload/App.app does not exist in $ipa"
    echo "ERROR: Payload/App.app not found in $ipa" >&2
    print_summary_table
    exit 1
  fi
  record_result "App.app" "App Bundle Present" "PASS" "Payload/App.app exists"

  # Read MinimumOSVersion from App.app/Info.plist (defaulting to 15.0 if missing)
  if [ -z "$APP_MIN_OS" ]; then
    local app_plist="$app_bundle/Info.plist"
    if [ -f "$app_plist" ]; then
      if [ -x /usr/libexec/PlistBuddy ]; then
        APP_MIN_OS="$(/usr/libexec/PlistBuddy -c "Print :MinimumOSVersion" "$app_plist" 2>/dev/null | tr -d '[:space:]' || true)"
      fi
      if [ -z "$APP_MIN_OS" ]; then
        APP_MIN_OS="$("$PYTHON_BIN" -c "
import plistlib, sys
try:
    with open(sys.argv[1], 'rb') as f:
        d = plistlib.load(f)
    print(d.get('MinimumOSVersion', '15.0'))
except Exception:
    print('15.0')
" "$app_plist" 2>/dev/null | tr -d '[:space:]' || echo "15.0")"
      fi
    fi
    APP_MIN_OS="$(echo "${APP_MIN_OS:-15.0}" | tr -d '[:space:]')"
  fi

  echo "Validating IPA $ipa (target MinimumOSVersion: $APP_MIN_OS)..."

  # Check core frameworks in Payload/App.app/Frameworks/
  local frameworks_dir="$app_bundle/Frameworks"
  local found_any_core=0

  for core in $CORES_LIST; do
    local fw_path="$frameworks_dir/${core}.framework"
    if [ ! -d "$fw_path" ]; then
      record_result "$core" "Framework Present" "FAIL" "Missing ${core}.framework in Frameworks/"
      echo "[ERROR] Required core framework missing: $fw_path" >&2
    else
      found_any_core=1
      record_result "$core" "Framework Present" "PASS" "Found ${core}.framework"
      validate_check1 "$fw_path" "$core" || true
      validate_check2 "$fw_path" "$core" "$APP_MIN_OS" || true
      validate_check3 "$fw_path" "$core" || true
      validate_check4 "$fw_path" "$core" || true
      validate_check5 "$fw_path" "$core" || true
      validate_check6 "$fw_path" "$core" "$APP_MIN_OS" || true
    fi
  done

  if [ $found_any_core -eq 0 ]; then
    record_result "App.app" "Core Frameworks Count" "FAIL" "No core frameworks from cores.lock.json found in Frameworks/"
    echo "[ERROR] No core frameworks from cores.lock.json found in $frameworks_dir" >&2
  fi

  # Run codesign check on Payload/App.app
  validate_codesign "$app_bundle" || true
}

# ==============================================================================
# Main Execution
# ==============================================================================

if [ "$MODE" = "framework" ]; then
  run_framework_mode
elif [ "$MODE" = "ipa" ]; then
  run_ipa_mode
fi

print_summary_table

if [ "$TOTAL_FAILURES" -gt 0 ]; then
  echo "Validation Gate: FAILED with $TOTAL_FAILURES failure(s)." >&2
  exit 1
else
  echo "Validation Gate: ALL CHECKS PASSED."
  exit 0
fi
