#!/usr/bin/env bash
# Installs the pinned .NET SDK plus the wasm-tools workload (which bundles Emscripten 3.1.56)
# into ~/.towerfall-browser/tools/dotnet, outside the repo: Emscripten's wrapper scripts break
# on paths with spaces. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
SDK_VERSION=10.0.401
ROOT="${TOWERFALL_TOOLS:-$HOME/.towerfall-browser/tools}"
mkdir -p "$ROOT"
if [ ! -x "$ROOT/dotnet/dotnet" ] || ! "$ROOT/dotnet/dotnet" --list-sdks | grep -q "^$SDK_VERSION "; then
	curl -sSLf https://dot.net/v1/dotnet-install.sh -o "$ROOT/dotnet-install.sh"
	bash "$ROOT/dotnet-install.sh" --version "$SDK_VERSION" --install-dir "$ROOT/dotnet"
fi
source ./env.sh
if ! dotnet workload list | grep -q "^wasm-tools "; then
	dotnet workload install wasm-tools
fi
dotnet --version
