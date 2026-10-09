#!/usr/bin/env bash
# Installs a self-contained Rust toolchain (stable, minimal) with the WebAssembly targets.
set -euo pipefail
cd "$(dirname "$0")/.."
source tools/rustenv.sh
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
	mkdir -p "$RUSTUP_HOME" "$CARGO_HOME"
	curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable
fi
rustup default stable >/dev/null
rustup target add wasm32-unknown-emscripten wasm32-unknown-unknown
# Netplay builds with a pinned nightly (see tools/build-netplay.sh).
rustup toolchain install nightly-2025-02-01 --profile minimal --component rust-src
rustc --version
