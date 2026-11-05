#!/bin/sh
set -eu

# Runs a command (usually npm) with Node.js 22. Uses the system Node when it is
# version 22; otherwise uses a checksum-verified runtime inside .context/ only.
# Nothing is installed globally.
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" = "22" ]; then
    exec "$@"
  fi
fi

runtime_dir=".context/runtime/node-v22.23.4-darwin-arm64"
if [ ! -x "$runtime_dir/bin/node" ]; then
  if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "Node.js 22 is required. Install the version in .nvmrc (for example with nvm) and retry." >&2
    exit 1
  fi
  archive=".context/runtime/node-v22.23.4-darwin-arm64.tar.gz"
  mkdir -p .context/runtime
  curl -fsSL "https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-arm64.tar.gz" -o "$archive"
  printf '%s  %s\n' 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428' "$archive" | shasum -a 256 -c -
  tar -xzf "$archive" -C .context/runtime
fi

PATH="$PWD/$runtime_dir/bin:$PATH"
export PATH
exec "$@"
