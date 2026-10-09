# Source this to use the Emscripten bundled with the .NET wasm-tools workload (the same version
# the prebuilt FNA libs were built with: 3.1.56). Works for any host OS/arch the workload ships.
source "$(dirname "${BASH_SOURCE[0]:-$0}")/../env.sh"
_P="$DOTNET_ROOT/packs"
_pack() { # newest version dir of the named pack (e.g. _pack Sdk), or nothing if it isn't installed
	local d
	d=$( (ls -d "$_P"/Microsoft.NET.Runtime.Emscripten.3.1.56."$1".*/ 2>/dev/null || true) | head -1)
	if [ -n "$d" ]; then
		(ls -d "$d"*/ 2>/dev/null || true) | sort -V | tail -1 | sed 's:/$::'
	fi
	return 0
}
_SDK="$(_pack Sdk)"
[ -n "$_SDK" ] || { echo "Emscripten workload pack not found under $_P (run tools/install-sdk.sh)" >&2; return 1 2>/dev/null || exit 1; }
export EMSDK_TOOLS="$_SDK/tools"
export DOTNET_EMSCRIPTEN_LLVM_ROOT="$EMSDK_TOOLS/bin"
export DOTNET_EMSCRIPTEN_BINARYEN_ROOT="$EMSDK_TOOLS"
_NODE="$(_pack Node)"
if [ -n "$_NODE" ]; then export DOTNET_EMSCRIPTEN_NODE_JS="$_NODE/tools/bin/node"; fi
export EM_CACHE="$(_pack Cache)/tools/emscripten/cache"
export EM_FROZEN_CACHE=1
export PYTHONUTF8=1
export PATH="$EMSDK_TOOLS/bin:$EMSDK_TOOLS/emscripten:$PATH"
# macOS ships no suitable python for emscripten; the workload brings one there.
_PY="$(_pack Python)"
if [ -n "$_PY" ]; then export PATH="$_PY/tools/bin:$PATH"; fi
