#!/usr/bin/env bash
# Decompiles your own TowerFall.exe into the gitignored reference/rebuild/, rebuilds it from that
# source, and compares the rebuild with the original method by method (tools/ILCompare). The
# rebuilt TowerFall.exe runs in the browser in place of the original (docs/DECOMP.md).
# Decompiled source is game code: never commit it or put it anywhere public.
#   tools/decomp-rebuild.sh [dir with TowerFall.exe]   (default: the Steam install's)
# Needs ilspycmd (dotnet tool install -g ilspycmd; results below are from 9.1.0.7988).
set -euo pipefail
cd "$(dirname "$0")/.."
source env.sh
TF="${1:-$HOME/Library/Application Support/Steam/steamapps/common/TowerFall/TowerFall.app/Contents/Resources}"
[ -f "$TF/TowerFall.exe" ] || { echo "No TowerFall.exe in $TF" >&2; exit 1; }
OUT=reference/rebuild
rm -rf "$OUT" && mkdir -p "$OUT"
# ilspycmd targets .NET 8; env.sh's DOTNET_ROOT only has .NET 10.
DOTNET_ROLL_FORWARD=Major ilspycmd -p -o "$OUT" --nested-directories -r "$TF" "$TF/TowerFall.exe" >/dev/null

# The decompiler's output needs three mechanical fixes to build:
# - .NET Framework 4.0 reference assemblies, instead of the game's Mono System.Core/System.Xml;
# - C# 13 (ref locals in iterators);
# - MathF.PI (how ILSpy prints the float constant π) and System.Index (array[^1]), which .NET 4.0
#   lacks.
# The original was a Debug build (no optimization) by the C# 5-era Microsoft compiler, so the
# rebuild is a Debug build too: that's much closer to the original IL than Release.
python3 - "$OUT/TowerFall.csproj" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'<Reference Include="System\.(Core|Xml)">.*?</Reference>\s*', '', s, flags=re.S)
s = s.replace('<ItemGroup />', '<ItemGroup><PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" /><Reference Include="System.Xml" /><Reference Include="System.Core" /></ItemGroup>')
s = re.sub(r'<LangVersion>[^<]*</LangVersion>', '<LangVersion>latest</LangVersion>', s)
s = s.replace('</PlatformTarget>', '</PlatformTarget><NoWarn>$(NoWarn);CS0162;CS0168;CS0219;CS0414;CS0649;CS0169;CS8981</NoWarn>')
open(p, 'w').write(s)
PY
cat > "$OUT/DecompShims.cs" <<'CS'
namespace System
{
	internal static class MathF { public const float PI = 3.1415927f; }
	internal readonly struct Index
	{
		private readonly int value;
		public Index(int value, bool fromEnd = false) { this.value = fromEnd ? ~value : value; }
		public int GetOffset(int length) => value < 0 ? length + value + 1 : value;
	}
}
CS

dotnet build "$OUT/TowerFall.csproj" -c Debug -v q -clp:NoSummary
dotnet run --project tools/ILCompare -c Release -- "$TF/TowerFall.exe" "$OUT/bin/Debug/net40/TowerFall.exe" "$OUT/ildiff"
echo "Rebuilt: $OUT/bin/Debug/net40/TowerFall.exe (differing methods: $OUT/ildiff)"
