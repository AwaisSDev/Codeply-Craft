#!/usr/bin/env python3
"""Split large release files into parts that fit GitHub's 100 MB file limit, and put them back together.

    python pack.py split <file> [--out weights/] [--mb 95]     # writes <file>.part-000 …, updates weights/PARTS.json
    python pack.py join  [--dir weights/] [--out .]            # rebuilds every file listed in PARTS.json, verifies sha256
    python pack.py verify [--dir weights/]                     # checks the parts on disk against PARTS.json

Standard library only. `join` refuses to write a file whose checksum does not match.
"""
import argparse
import hashlib
import json
from pathlib import Path


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def split(a):
    src, out = Path(a.file), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "PARTS.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for old in out.glob(src.name + ".part-*"):
        old.unlink()
    size, parts = a.mb * 1024 * 1024, []
    with open(src, "rb") as f:
        i = 0
        while True:
            chunk = f.read(size)
            if not chunk:
                break
            p = out / f"{src.name}.part-{i:03d}"
            p.write_bytes(chunk)
            parts.append({"name": p.name, "bytes": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})
            i += 1
    manifest[src.name] = {"bytes": src.stat().st_size, "sha256": sha256(src), "parts": parts}
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"{src.name}: {len(parts)} parts, {src.stat().st_size / 1e6:.0f} MB, sha256 {manifest[src.name]['sha256']}")


def join(a):
    d, out = Path(a.dir), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, info in json.loads((d / "PARTS.json").read_text()).items():
        dst = out / name
        h = hashlib.sha256()
        with open(str(dst) + ".tmp", "wb") as f:
            for p in info["parts"]:
                data = (d / p["name"]).read_bytes()
                if hashlib.sha256(data).hexdigest() != p["sha256"]:
                    raise SystemExit(f"{p['name']}: checksum mismatch: the part is incomplete or corrupted, fetch it again")
                f.write(data)
                h.update(data)
        if h.hexdigest() != info["sha256"]:
            Path(str(dst) + ".tmp").unlink()
            raise SystemExit(f"{name}: checksum mismatch after joining")
        Path(str(dst) + ".tmp").replace(dst)
        print(f"{dst}: {info['bytes'] / 1e6:.0f} MB, sha256 ok")


def verify(a):
    d, bad = Path(a.dir), 0
    for name, info in json.loads((d / "PARTS.json").read_text()).items():
        for p in info["parts"]:
            f = d / p["name"]
            ok = f.exists() and sha256(f) == p["sha256"]
            bad += not ok
            if not ok:
                print("BAD", p["name"])
        print(f"{name}: {len(info['parts'])} parts checked")
    raise SystemExit(1 if bad else 0)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("split"); s.add_argument("file"); s.add_argument("--out", default="weights"); s.add_argument("--mb", type=int, default=95)
    j = sub.add_parser("join"); j.add_argument("--dir", default="weights"); j.add_argument("--out", default=".")
    v = sub.add_parser("verify"); v.add_argument("--dir", default="weights")
    a = ap.parse_args()
    {"split": split, "join": join, "verify": verify}[a.cmd](a)
