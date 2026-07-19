#!/bin/sh
# Install Shellink CLI from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jie123108/Shellink/main/install.sh -o /tmp/shellink-install.sh
#   cat /tmp/shellink-install.sh
#   sh /tmp/shellink-install.sh
#   sh /tmp/shellink-install.sh --version v0.1.0
#   ./install.sh [--version TAG] [--dir DIR]
#
# Environment:
#   SHELLINK_VERSION  Release tag (e.g. v0.1.0). Overrides default "latest".
#   SHELLINK_INSTALL_DIR  Install directory (default: $HOME/.local/bin).
#
# Windows is not supported; build from source instead:
#   https://github.com/jie123108/Shellink#installation

set -eu

REPO="jie123108/Shellink"
GITHUB_API="https://api.github.com/repos/${REPO}"
GITHUB_RELEASE="https://github.com/${REPO}/releases/download"
DEFAULT_BIN_DIR="${HOME}/.local/bin"

VERSION="${SHELLINK_VERSION:-}"
BIN_DIR="${SHELLINK_INSTALL_DIR:-${DEFAULT_BIN_DIR}}"

usage() {
  cat <<'EOF'
Install Shellink CLI from GitHub Releases.

Usage:
  install.sh [--version TAG] [--dir DIR]
  install.sh --help

Options:
  --version TAG   Release tag (e.g. v0.1.0). Default: latest release.
  --dir DIR       Install directory. Default: $HOME/.local/bin
  --help          Show this help.

Environment:
  SHELLINK_VERSION       Same as --version
  SHELLINK_INSTALL_DIR   Same as --dir

Supported platforms: macOS/Linux (x64, arm64).
Windows is not supported; build from source (see repository README).
EOF
}

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "required command not found: $1"
  fi
}

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    die "need curl or wget to download"
  fi
}

fetch_text() {
  url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
  else
    die "need curl or wget to download"
  fi
}

is_windows() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) return 0 ;;
  esac
  case "${OS:-}" in
    Windows_NT) return 0 ;;
  esac
  return 1
}

detect_target() {
  if is_windows; then
    cat >&2 <<'EOF'
error: Windows is not supported by prebuilt Shellink binaries.

Build from source instead:
  git clone https://github.com/jie123108/Shellink.git
  cd Shellink
  npm install
  npm run build
  # CLI: ./node_modules/.bin/shellink

Or with Bun for a standalone binary on a supported host:
  npm run build:binary
EOF
    exit 1
  fi

  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os_name="darwin" ;;
    Linux) os_name="linux" ;;
    *) die "unsupported OS: $os (supported: macOS, Linux)" ;;
  esac

  case "$arch" in
    arm64|aarch64) arch_name="arm64" ;;
    x86_64|amd64) arch_name="x64" ;;
    *) die "unsupported architecture: $arch (supported: x64, arm64)" ;;
  esac

  printf '%s\n' "shellink-${os_name}-${arch_name}"
}

resolve_version() {
  if [ -n "$VERSION" ]; then
    case "$VERSION" in
      v*) printf '%s\n' "$VERSION" ;;
      *) printf 'v%s\n' "$VERSION" ;;
    esac
    return
  fi

  need_cmd sed
  tag="$(fetch_text "${GITHUB_API}/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$tag" ]; then
    die "could not resolve latest release tag from GitHub API"
  fi
  printf '%s\n' "$tag"
}

verify_checksum() {
  sums_file="$1"
  asset_name="$2"
  expected="$(awk -v name="$asset_name" '
    {
      file = $2
      sub(/^\.\//, "", file)
      if (file == name) {
        print $1
        exit
      }
    }
  ' "$sums_file")"
  if [ -z "$expected" ]; then
    die "checksum for ${asset_name} not found in SHA256SUMS.txt"
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$asset_name" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$asset_name" | awk '{print $1}')"
  else
    die "need sha256sum or shasum to verify download"
  fi

  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for ${asset_name} (expected ${expected}, got ${actual})"
  fi
  log "checksum ok: ${asset_name}"
}

path_has_dir() {
  dir="$1"
  old_ifs="$IFS"
  IFS=:
  for p in $PATH; do
    if [ "$p" = "$dir" ]; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || die "--dir requires a value"
      BIN_DIR="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

need_cmd uname
need_cmd mktemp
need_cmd mkdir
need_cmd chmod
need_cmd mv
need_cmd awk
need_cmd head

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  die "need curl or wget to download"
fi

ASSET="$(detect_target)"
TAG="$(resolve_version)"
log "installing Shellink ${TAG} (${ASSET})"

TMPDIR_INSTALL="$(mktemp -d "${TMPDIR:-/tmp}/shellink-install.XXXXXX")"
cleanup() {
  rm -rf "$TMPDIR_INSTALL"
}
trap cleanup EXIT INT HUP TERM

cd "$TMPDIR_INSTALL"

download "${GITHUB_RELEASE}/${TAG}/${ASSET}" "$ASSET"
download "${GITHUB_RELEASE}/${TAG}/SHA256SUMS.txt" "SHA256SUMS.txt"
verify_checksum "SHA256SUMS.txt" "$ASSET"

mkdir -p "$BIN_DIR"
DEST="${BIN_DIR}/shellink"
mv "$ASSET" "$DEST"
chmod +x "$DEST"

log "installed: ${DEST}"

if ! path_has_dir "$BIN_DIR"; then
  log ""
  log "note: ${BIN_DIR} is not on PATH. Add it, for example:"
  log "  export PATH=\"${BIN_DIR}:\$PATH\""
  log "Then add that line to your shell profile (~/.bashrc, ~/.zshrc, etc.)."
fi

if "$DEST" -V >/dev/null 2>&1; then
  ver_out="$("$DEST" -V 2>&1 || true)"
  log "verified: ${ver_out}"
else
  die "installed binary failed to run: ${DEST} -V"
fi

log "done. Run: shellink --help"
