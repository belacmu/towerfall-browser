#!/usr/bin/env bash
# Builds ggrs_ffi, the native library TF.EX (the netplay mod) uses, for the browser:
# vendor/netplay/ggrs_ffi.a, linked into the app with netplay/tfnet.js (see docs/MULTIPLAYER.md).
#
# Sources: Fcornaire/ggrs-ffi and Fcornaire/ggrs (TF.EX's forks), at pinned commits, with
# netplay/ggrs-ffi.patch and netplay/ggrs.patch. matchbox_socket is replaced by
# netplay/matchbox-browser (WebRTC done by the page). Needs the Rust toolchain from
# tools/install-rust.sh (nightly: the standard library is rebuilt with thread support so it can
# link into the threaded WebAssembly module).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
GGRS_FFI_COMMIT=16859a599ecf73475a90cd9596c7d9c0d52a8beb
GGRS_COMMIT=12a2d476653873042df38496386415124693acb9
# A nightly on LLVM 19, like Emscripten 3.1.56: newer LLVMs tag objects with WebAssembly features
# (bulk-memory-opt, call-indirect-overlong) that its wasm-opt doesn't know.
RUST_TOOLCHAIN=nightly-2025-02-01
SRC=vendor/netplay-src
OUT=vendor/netplay

want="$RUST_TOOLCHAIN $GGRS_FFI_COMMIT $GGRS_COMMIT $(cat netplay/*.patch netplay/matchbox-browser/Cargo.toml netplay/matchbox-browser/src/*.rs | shasum -a 256 | cut -c1-16)"
[ -f $OUT/ggrs_ffi.a ] && [ "$(cat $OUT/.stamp 2>/dev/null)" = "$want" ] && exit 0

fetch() { # repo dir commit patch
	rm -rf "$SRC/$2"
	git init -q "$SRC/$2"
	git -C "$SRC/$2" remote add origin "https://github.com/$1"
	git -C "$SRC/$2" fetch -q --depth 1 origin "$3"
	git -C "$SRC/$2" checkout -q FETCH_HEAD
	patch -d "$SRC/$2" -p1 --forward < "$4"
}
mkdir -p $SRC $OUT
fetch Fcornaire/ggrs ggrs $GGRS_COMMIT netplay/ggrs.patch
fetch Fcornaire/ggrs-ffi ggrs-ffi $GGRS_FFI_COMMIT netplay/ggrs-ffi.patch

source tools/rustenv.sh
source tools/emenv.sh
# Build scripts link for the host; on macOS without an accepted Xcode license, the Command Line
# Tools still work.
if [ "$(uname)" = Darwin ] && [ -d /Library/Developer/CommandLineTools ] && ! cc -x c /dev/null -o /dev/null 2>/dev/null; then
	export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi
export RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals -C panic=abort"
(
	cd $SRC/ggrs-ffi/core
	rustup toolchain list | grep -q "^$RUST_TOOLCHAIN" || rustup toolchain install $RUST_TOOLCHAIN --profile minimal --component rust-src
	patches=(--config "patch.crates-io.matchbox_socket.path=\"$ROOT/netplay/matchbox-browser\""
		--config "patch.'https://github.com/Fcornaire/ggrs'.ggrs.path=\"$ROOT/$SRC/ggrs\"")
	# Dependency versions this (older) compiler supports. The GGRS fork only declares a newer one.
	rm -f Cargo.lock
	cargo +$RUST_TOOLCHAIN generate-lockfile "${patches[@]}"
	cargo +$RUST_TOOLCHAIN update "${patches[@]}" -p uuid --precise 1.18.1
	cargo +$RUST_TOOLCHAIN rustc --release --target wasm32-unknown-emscripten --ignore-rust-version \
		-Zbuild-std=std,panic_abort --crate-type staticlib "${patches[@]}"
)
# The archive's name is the P/Invoke library name TF.EX uses ("ggrs_ffi").
cp $SRC/ggrs-ffi/core/target/wasm32-unknown-emscripten/release/libggrs_ffi.a $OUT/ggrs_ffi.a
echo "$want" > $OUT/.stamp
echo "Built $OUT/ggrs_ffi.a"
