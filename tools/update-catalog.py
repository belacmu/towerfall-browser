#!/usr/bin/env python3
"""Builds mods/catalog.json: every TowerFall mod on GameBanana, with what the browser needs to offer it.

For each mod: its latest zip (checked against GameBanana's MD5), the FortRise metadata inside it
(meta.json: name, version, dependencies; a zip can hold several mods), whether it needs Harmony
(not supported in the browser yet) or native libraries (never), the license checklist (whether we
may host a copy), and a download URL the page can fetch cross-origin. GameBanana's download links
redirect through a host without CORS headers, so the final mirror URL is resolved here; the page
falls back to asking the player for the zip if a mirror has moved.

mods/overrides.json (hand-written) can set "status"/"note" per mod name, e.g. after testing.
Downloads are cached in vendor/mod-cache/. Usage: tools/update-catalog.py [--limit N]
"""
import hashlib
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME_ID = 18654  # TowerFall on GameBanana
API = "https://gamebanana.com/apiv11"
CACHE = os.path.join(ROOT, "vendor", "mod-cache")
OUT = os.path.join(ROOT, "mods", "catalog.json")
OVERRIDES = os.path.join(ROOT, "mods", "overrides.json")
UA = {"User-Agent": "towerfall-browser-catalog (+https://github.com/belacmu/towerfall-browser)"}
REDISTRIBUTE = "Redistribute this Mod on other sites"


def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def list_mods():
    page, mods = 1, []
    while True:
        q = urllib.parse.urlencode({"_nPerpage": 50, "_nPage": page, "_aFilters[Generic_Game]": GAME_ID})
        d = get_json(f"{API}/Mod/Index?{q}")
        mods += d.get("_aRecords", [])
        if d.get("_aMetadata", {}).get("_bIsComplete", True):
            return mods
        page += 1


def final_url(url):
    """Follows redirects; returns the last URL (a filecache mirror that sends CORS headers)."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    for _ in range(5):
        req = urllib.request.Request(url, method="HEAD", headers=UA)
        try:
            with opener.open(req, timeout=60):
                return url
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                continue
            raise
    return url


def download(url, md5):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, md5 + ".zip")
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
        if hashlib.md5(data).hexdigest() != md5:
            raise ValueError(f"MD5 mismatch for {url}")
        with open(path, "wb") as f:
            f.write(data)
    with open(path, "rb") as f:
        data = f.read()
    return data


def lower_keys(d):
    return {k.lower(): v for k, v in d.items()} if isinstance(d, dict) else {}


def dep_list(deps):
    out = []
    for d in deps or []:
        if isinstance(d, str):
            name, _, version = d.partition(":")
            out.append({"name": name, "version": version})
        else:
            d = lower_keys(d)
            out.append({"name": d.get("name"), "version": d.get("version")})
    return out


def inspect_zip(data):
    """FortRise mods inside the zip: one per meta.json (the zip root or one level of folders)."""
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    found = []
    for meta_path in sorted(n for n in names if n.lower().endswith("meta.json") and n.count("/") <= 2):
        base = meta_path[: -len("meta.json")]
        try:
            meta = lower_keys(json.loads(z.read(meta_path).decode("utf-8-sig")))
        except Exception:
            continue
        if not meta.get("name"):
            continue
        dll = meta.get("dll")
        dll_bytes = b""
        if dll:
            for n in names:
                if n.lower() == (base + dll).lower():
                    dll_bytes = z.read(n)
        found.append({
            "name": meta["name"],
            "version": meta.get("version"),
            "displayName": meta.get("displayname") or meta["name"],
            "folder": base.rstrip("/"),
            "dll": dll,
            "dependencies": dep_list(meta.get("dependencies")),
            "optionalDependencies": dep_list(meta.get("optionaldependencies")),
            "harmony": b"0Harmony" in dll_bytes,
            "native": any(n.startswith(base + "Unmanaged/") and not n.endswith("/") for n in names),
        })
    return found


def status_of(m):
    """Default status before anyone has tested the mod in the browser (mods/overrides.json wins).
    "works": verified; "untested"; "broken"/"unsupported": not offered on the page."""
    if m["native"]:
        return "unsupported", "Ships native libraries, which can't run in the browser."
    return "untested", "Not tested in the browser yet."


def main():
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    overrides = json.load(open(OVERRIDES)) if os.path.exists(OVERRIDES) else {}
    entries = []
    records = list_mods()[:limit]
    for i, rec in enumerate(records, 1):
        gb_id = rec["_idRow"]
        try:
            prof = get_json(f"{API}/Mod/{gb_id}/ProfilePage")
            files = [f for f in prof.get("_aFiles", []) if f.get("_sFile", "").lower().endswith(".zip")]
            if not files:
                print(f"[{i}/{len(records)}] {rec['_sName']}: no zip, skipped")
                continue
            file = max(files, key=lambda f: f.get("_tsDateAdded", 0))
            data = download(file["_sDownloadUrl"], file["_sMd5Checksum"])
            mods = inspect_zip(data)
            if not mods:
                print(f"[{i}/{len(records)}] {rec['_sName']}: no FortRise meta.json, skipped")
                continue
            checklist = prof.get("_aLicenseChecklist") or {}
            preview = (prof.get("_aPreviewMedia") or {}).get("_aImages") or []
            entry = {
                "gamebanana": gb_id,
                "title": prof.get("_sName"),
                "author": (prof.get("_aSubmitter") or {}).get("_sName"),
                "category": (prof.get("_aCategory") or {}).get("_sName"),
                "page": prof.get("_sProfileUrl"),
                "image": (preview[0]["_sBaseUrl"] + "/" + preview[0].get("_sFile220", preview[0]["_sFile"])) if preview else None,
                "updated": prof.get("_tsDateUpdated") or prof.get("_tsDateModified"),
                "redistributable": REDISTRIBUTE in (checklist.get("yes") or []),
                "file": {
                    "name": file["_sFile"],
                    "size": file["_nFilesize"],
                    "md5": file["_sMd5Checksum"],
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "download": file["_sDownloadUrl"],
                    "mirror": final_url(file["_sDownloadUrl"]),
                },
                "mods": [],
            }
            for m in mods:
                status, note = status_of(m)
                o = overrides.get(m["name"], {})
                m["status"] = o.get("status", status)
                m["note"] = o.get("note", note)
                entry["mods"].append(m)
            entries.append(entry)
            print(f"[{i}/{len(records)}] {rec['_sName']}: " + ", ".join(f"{m['name']} {m['version']} ({m['status']})" for m in mods))
        except Exception as e:
            print(f"[{i}/{len(records)}] {rec.get('_sName')}: error {e}", file=sys.stderr)
        time.sleep(0.3)  # be polite to GameBanana
    entries.sort(key=lambda e: (e["category"] or "", (e["title"] or "").lower()))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"source": "gamebanana", "game": GAME_ID, "mods": entries}, f, indent=1)
        f.write("\n")
    print(f"Wrote {OUT}: {len(entries)} GameBanana entries, {sum(len(e['mods']) for e in entries)} mods")


if __name__ == "__main__":
    main()
