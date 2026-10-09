# Source this to use the project's .NET SDK (with the wasm-tools workload), installed by
# tools/install-sdk.sh. It lives outside the repo because Emscripten's wrapper scripts break on
# paths with spaces. Override the location with TOWERFALL_TOOLS.
_tools="${TOWERFALL_TOOLS:-$HOME/.towerfall-browser/tools}"
export DOTNET_ROOT="$_tools/dotnet"
export DOTNET_CLI_HOME="$_tools/home"
export PATH="$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
