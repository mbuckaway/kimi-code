#!/usr/bin/env bash
# Native installer for the mbuckaway/kimi-code fork.
# Downloads the latest fork release from GitHub Releases (version discovered
# via the GitHub Pages update channel) and installs it as ~/.kimi-code/bin/kimi.
#
#   curl -fsSL https://mbuckaway.github.io/kimi-code/install.sh | bash
#
# macOS builds are unsigned. Downloads via curl (this script) do not get the
# quarantine attribute, so no extra step is needed; if the zip was fetched
# through a browser instead, run: xattr -d com.apple.quarantine ~/.kimi-code/bin/kimi
#
# Trust model (read this before piping it to bash): this script, the version
# pointer, and the expected SHA-256 all come from the SAME GitHub Pages origin,
# and that origin is refreshed by the same workflow that publishes the release
# zips. So the checksum below only proves the zip arrived intact and was not
# swapped out on its own — it is NOT independent verification. Anyone who can
# publish to the gh-pages channel can serve a malicious zip together with a
# matching sum, and fork builds carry no code signature (there are no signing
# secrets on the fork, by design). For a stronger guarantee, download the asset
# from the GitHub release for the tag you want and check it against the sums
# attached to that release instead of running this script unattended.

set -euo pipefail

CHANNEL_BASE="https://mbuckaway.github.io/kimi-code"
REPO="mbuckaway/kimi-code"
BIN_DIR="${KIMI_CODE_HOME:-$HOME/.kimi-code}/bin"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in
  darwin) platform="darwin" ;;
  linux) platform="linux" ;;
  *) echo "Unsupported OS: $os (use npm or build from source)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64 | amd64) target="$platform-x64" ;;
  arm64 | aarch64) target="$platform-arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

version=$(curl -fsSL "$CHANNEL_BASE/latest" | tr -d '[:space:]')
if [ -z "$version" ]; then
  echo "Could not read latest version from $CHANNEL_BASE/latest" >&2
  exit 1
fi

tag="v$version"
zip="kimi-code-$target.zip"
url="https://github.com/$REPO/releases/download/$tag/$zip"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Installing kimi-code $version ($target) from $REPO..."
curl -fsSL "$url" -o "$tmp/$zip"

expected=$(curl -fsSL "$CHANNEL_BASE/sha256/$target.sha256" | cut -d' ' -f1)
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$zip" | cut -d' ' -f1)
else
  actual=$(sha256sum "$tmp/$zip" | cut -d' ' -f1)
fi
if [ "$actual" != "$expected" ]; then
  echo "Checksum mismatch for $zip" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
unzip -o "$tmp/$zip" -d "$tmp/extract" >/dev/null
mv "$tmp/extract/kimi" "$BIN_DIR/kimi"
chmod +x "$BIN_DIR/kimi"

echo "Installed $BIN_DIR/kimi"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to your PATH, e.g.: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
