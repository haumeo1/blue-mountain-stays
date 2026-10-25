#!/bin/sh
set -eu

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  exec "$@"
fi

runtime_dir=".context/runtime/node-v22.23.4-darwin-arm64"
if [ ! -x "$runtime_dir/bin/node" ]; then
  if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "Node.js 20+ is required. Install Node or use the repository's .nvmrc version." >&2
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
