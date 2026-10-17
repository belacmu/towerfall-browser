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
GGRS_FFI_COMMIT=2fe64d9a8f1240db844ea81aa69f940c7daacfd6
GGRS_COMMIT=c510c22e66a35786599a58c15d189bffb4a46dae
# A nightly on LLVM 19, like Emscripten 3.1.56: newer LLVMs tag objects with WebAssembly features
# (bulk-memory-opt, call-indirect-overlong) that its wasm-opt doesn't know.
RUST_TOOLCHAIN=nightly-2025-02-01
# NETPLAY_SRC / NETPLAY_OUT build somewhere else (e.g. a scratch copy, linked with build.sh's
# MSBUILD_ARGS=-p:NetplayDir=<NETPLAY_OUT>), leaving vendor/ as it is.
SRC=${NETPLAY_SRC:-vendor/netplay-src}
OUT=${NETPLAY_OUT:-vendor/netplay}

want="$RUST_TOOLCHAIN $GGRS_FFI_COMMIT $GGRS_COMMIT $(cat netplay/*.patch netplay/ggrs-ffi.Cargo.lock netplay/matchbox-browser/Cargo.toml netplay/matchbox-browser/src/*.rs tools/build-netplay.sh tools/emenv.sh | shasum -a 256 | cut -c1-16)"
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
SRC_ABS=$(cd "$SRC" && pwd)
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
		--config "patch.'https://github.com/Fcornaire/ggrs'.ggrs.path=\"$SRC_ABS/ggrs\"")
	# Exactly the crate versions in netplay/ggrs-ffi.Cargo.lock (built and tested with), not whatever
	# is newest on crates.io at build time. To update it: rm Cargo.lock; cargo +$RUST_TOOLCHAIN
	# generate-lockfile with the patches below; cargo update -p uuid --precise 1.18.1 (a version this
	# older compiler supports; the GGRS fork only declares a newer one); copy it back.
	cp "$ROOT/netplay/ggrs-ffi.Cargo.lock" Cargo.lock
	cargo +$RUST_TOOLCHAIN rustc --release --locked --target wasm32-unknown-emscripten --ignore-rust-version \
		-Zbuild-std=std,panic_abort --crate-type staticlib "${patches[@]}"
)
# The archive's name is the P/Invoke library name TF.EX uses ("ggrs_ffi").
cp $SRC/ggrs-ffi/core/target/wasm32-unknown-emscripten/release/libggrs_ffi.a $OUT/ggrs_ffi.a
echo "$want" > $OUT/.stamp
echo "Built $OUT/ggrs_ffi.a"
