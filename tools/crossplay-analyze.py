#!/usr/bin/env python3
# Usage: tools/crossplay-analyze.py reference/decompile   (docs/SWITCH-CROSSPLAY.md, checks 1b and 1c)
# Rough static analysis of the decompiled PC TowerFall (ILSpy output): which math functions and which
# order-sensitive constructs can run during a game update (not drawing). Name-based call graph:
# over-approximates (a call to Foo reaches every method named Foo), so it misses little.
import os, re, sys, collections
root = sys.argv[1]
SKIP = re.compile(r"Render|Draw|Debug|Editor|Menu|Button|Tip|Archive|Replay|Credits|Options|Leaderboard|Steam")
METHOD = re.compile(r"^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|new|unsafe|extern)\s+)+[\w<>\[\],\.\s]+?\s(\w+)\s*\([^;]*\)\s*(?:where[^{]*)?$")
methods = {}  # "File::Class.Method#n" -> body text
byname = collections.defaultdict(list)
for dp, _, fs in os.walk(root):
    for f in fs:
        if not f.endswith(".cs"): continue
        path = os.path.join(dp, f); rel = os.path.relpath(path, root)
        lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
        i = 0
        while i < len(lines):
            m = METHOD.match(lines[i])
            if m and i + 1 < len(lines) and lines[i + 1].strip() == "{":
                name = m.group(1); depth = 0; body = []; j = i + 1
                while j < len(lines):
                    depth += lines[j].count("{") - lines[j].count("}"); body.append(lines[j]); j += 1
                    if depth == 0: break
                key = f"{rel}::{name}#{i+1}"
                methods[key] = "\n".join(body); byname[name].append(key); i = j; continue
            i += 1
CALL = re.compile(r"(?<![\w.])(?:[\w.]+\.)?(\w+)\s*\(")
roots = [k for k in methods if re.search(r"::(Update|UpdateEntities|Update\w*)#", k) and not SKIP.search(k) and k.startswith(("TowerFall/", "Monocle/"))]
seen = set(); stack = list(roots)
while stack:
    k = stack.pop()
    if k in seen or SKIP.search(k.split("::")[1]): continue
    seen.add(k)
    for name in set(CALL.findall(methods[k])):
        for t in byname.get(name, []):
            if t not in seen: stack.append(t)
print(f"{len(methods)} methods, {len(roots)} Update roots, {len(seen)} reachable from them")
math = collections.Counter(); where = collections.defaultdict(set)
order = collections.defaultdict(list)
for k in seen:
    body = methods[k]; short = k.split("::")[0].replace("TowerFall/","").replace(".cs","") + "." + k.split("::")[1].split("#")[0]
    for fn in re.findall(r"\b(?:Math|MathF|MathHelper)\.(\w+)\s*\(", body):
        math[fn] += 1; where[fn].add(short)
    for label, pat in [("foreach over Dictionary/HashSet/Keys/Values", r"foreach\s*\([^)]*\bin\b[^)]*(?:\.Keys|\.Values|[Dd]ictionary|HashSet|[Ss]et\b)"),
                       ("Sort / OrderBy", r"\.Sort\s*\(|\.OrderBy\w*\s*\(|Array\.Sort"),
                       ("GetHashCode", r"GetHashCode\s*\("),
                       ("Random (System)", r"new\s+Random\s*\(|\bRandom\.\w+")]:
        if re.search(pat, body): order[label].append(short)
print("\nMath functions reachable from game updates (call sites):")
for fn, n in math.most_common(): print(f"  {fn:12} {n:4}  e.g. {', '.join(sorted(where[fn])[:4])}")
print("\nOrder-sensitive constructs:")
for label, ks in order.items(): print(f"  {label}: {len(ks)} methods, e.g. {', '.join(sorted(set(ks))[:8])}")
