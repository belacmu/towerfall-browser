# Source this to use the project's Rust toolchain (installed by tools/install-rust.sh), kept under
# ~/.towerfall-browser like the .NET SDK. Used to build netplay's Rust pieces for WebAssembly.
_rust="${TOWERFALL_TOOLS:-$HOME/.towerfall-browser}/rust"
export RUSTUP_HOME="$_rust/rustup"
export CARGO_HOME="$_rust/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
