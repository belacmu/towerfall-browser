#!/usr/bin/env python3
"""Keeps the hosted TF.EX (online play) current. The official server only lets players on the
latest TF.EX play online, so a new release must reach the site quickly.

Checks TF.EX's latest GitHub release. It's adopted automatically (tools/fetch-tfex.sh's pin is
updated; CI then commits and redeploys) when it's safe:
  - it was built against the ggrs-ffi release we build for the browser (TF.EX's release workflow
    bundles the newest ggrs-ffi release at the time, and the browser can't use that native code;
    tools/build-netplay.sh builds the pinned commit instead);
  - FortRise as pinned in tools/fetch-fortrise.sh satisfies its FortRise dependency;
  - its lobby protocol (the WebSocket message models and MatchmakingService.cs) is unchanged since
    the TF.EX version our own server (cloudflare/tfex-server) was checked against, its TFEX_PROTOCOL.
Otherwise it says why, for an issue. Writes `changed=true|false` and `blocked=<reason>` to
$GITHUB_OUTPUT when set.
  tools/update-tfex.py [--check]   (--check: report only, change nothing)
"""
import hashlib, io, json, os, re, sys, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FETCH_TFEX = os.path.join(ROOT, "tools", "fetch-tfex.sh")
BUILD_NETPLAY = os.path.join(ROOT, "tools", "build-netplay.sh")
FETCH_FORTRISE = os.path.join(ROOT, "tools", "fetch-fortrise.sh")
SERVER_PROTOCOL = os.path.join(ROOT, "cloudflare", "tfex-server", "TFEX_PROTOCOL")
PROTOCOL_FILES = ("src/network/TF.EX.Domain/Models/WebSocket/", "src/network/TF.EX.Domain/Services/MatchmakingService.cs")


def api(path):
    req = urllib.request.Request(f"https://api.github.com/{path}", headers={"Accept": "application/vnd.github+json", "User-Agent": "towerfall-browser"})
    if os.environ.get("GH_TOKEN"):
        req.add_header("Authorization", f"Bearer {os.environ['GH_TOKEN']}")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": "towerfall-browser"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def pinned(path, name):
    m = re.search(rf"^{name}=(\S+)", open(path).read(), re.M)
    if not m:
        sys.exit(f"{name} not found in {path}")
    return m.group(1)


def semver(v):
    """Sort key for versions like 5.5.0, 5.5.0-beta.3 (a release sorts after its pre-releases)."""
    core, _, pre = v.lstrip("v").partition("-")
    nums = tuple(int(x) for x in core.split("."))
    if not pre:
        return nums, (1,)
    parts = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split("."))
    return nums, (0,) + parts


def output(**values):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            for k, v in values.items():
                f.write(f"{k}={v}\n")


def main():
    check_only = "--check" in sys.argv
    current = pinned(FETCH_TFEX, "TFEX_VERSION")
    ggrs_commit = pinned(BUILD_NETPLAY, "GGRS_FFI_COMMIT")
    fortrise = pinned(FETCH_FORTRISE, "FORTRISE_VERSION")

    release = api("repos/Fcornaire/TF.EX/releases/latest")
    tag = release["tag_name"]
    print(f"TF.EX pinned {current}, latest {tag}")
    if tag == current:
        output(changed="false", blocked="")
        return

    problems = []
    # The ggrs-ffi release that was newest when this TF.EX was published.
    published = release["published_at"]
    ggrs_releases = [r for r in api("repos/Fcornaire/ggrs-ffi/releases") if not r["draft"] and r["published_at"] <= published]
    if not ggrs_releases:
        problems.append("couldn't tell which ggrs-ffi release it bundles")
    else:
        bundled = max(ggrs_releases, key=lambda r: r["published_at"])
        bundled_commit = api(f"repos/Fcornaire/ggrs-ffi/commits/{bundled['tag_name']}")["sha"]
        print(f"It bundles ggrs-ffi {bundled['tag_name']} ({bundled_commit[:12]}); the browser builds {ggrs_commit[:12]}")
        if bundled_commit != ggrs_commit:
            problems.append(
                f"it bundles ggrs-ffi {bundled['tag_name']} ({bundled_commit}), but the browser builds {ggrs_commit}: "
                "update GGRS_FFI_COMMIT in tools/build-netplay.sh (and netplay/ggrs-ffi.patch if needed), rebuild, and test online play"
            )

    asset_name = f"DShad.TF.EX-{tag}.zip"
    asset = next((a for a in release["assets"] if a["name"] == asset_name), None)
    if asset is None:
        problems.append(f"the release has no {asset_name}")
        data = None
    else:
        data = download(asset["browser_download_url"])
        meta = json.loads(zipfile.ZipFile(io.BytesIO(data)).read("DShad.TF.EX/meta.json").decode("utf-8-sig"))
        needs = next((d.get("version") for d in meta.get("dependencies", []) if d["name"] == "FortRise"), None)
        print(f"It needs FortRise {needs}; pinned {fortrise}")
        if needs and semver(needs) > semver(fortrise):
            problems.append(f"it needs FortRise {needs}, newer than the pinned {fortrise} (tools/fetch-fortrise.sh)")

    checked = open(SERVER_PROTOCOL).read().strip()
    compare = api(f"repos/Fcornaire/TF.EX/compare/{checked}...{tag}")
    changed = [f["filename"] for f in compare.get("files", []) if f["filename"].startswith(PROTOCOL_FILES)]
    print(f"Lobby protocol files changed since {checked}: {', '.join(changed) or 'none'}")
    if changed or len(compare.get("files", [])) >= 300:  # the compare API lists at most 300 files
        problems.append(
            f"its lobby protocol changed since {checked} ({', '.join(changed) or 'too many changes to tell'}): "
            "update cloudflare/tfex-server to match (docs/MULTIPLAYER.md), redeploy it, then set cloudflare/tfex-server/TFEX_PROTOCOL to "
            f"{tag}"
        )

    if problems:
        reason = "; ".join(problems)
        print(f"Not adopting {tag}: {reason}")
        output(changed="false", blocked=f"TF.EX {tag}: {reason}")
        return

    sha = hashlib.sha256(data).hexdigest()
    print(f"Adopting {tag} ({asset_name}, sha256 {sha})")
    if check_only:
        output(changed="false", blocked="")
        return
    text = open(FETCH_TFEX).read()
    text = re.sub(r"^TFEX_VERSION=\S+", f"TFEX_VERSION={tag}", text, flags=re.M)
    text = re.sub(r"^DShad\.TF\.EX:[0-9a-f]{64}$", f"DShad.TF.EX:{sha}", text, flags=re.M)
    open(FETCH_TFEX, "w").write(text)
    output(changed="true", blocked="", version=tag)


if __name__ == "__main__":
    main()
