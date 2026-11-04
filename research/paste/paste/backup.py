"""Persistent, append-only backup of run directories to a private Hugging Face repo, and exact restore.

Layout in the repo (default `Awais1290/paste-checkpoints`, private; override with PASTE_BACKUP_REPO):

    <prefix>/<run>/blobs/<sha256[:16]>-<file name>         content-addressed: a path never changes content
    <prefix>/<run>/snapshots/<UTC stamp>-<label>/MANIFEST.json

A snapshot is one commit holding its new blobs and its manifest, so it is either complete or absent. Nothing is ever
overwritten or deleted: an existing blob path already holds the same bytes, and every snapshot has its own manifest.
The manifest maps each file of the run directory (relative path) to its blob, sha256 and size, plus the resume point
read from last.pt metadata (pos, step) when present.

Consistency while a trainer is writing: files are first hard-linked (or copied) into a staging directory; the trainer
replaces checkpoints atomically (os.replace), so each staged file is one complete version, then it is hashed and
uploaded from the staging copy.

Restore downloads the latest (or a named) snapshot into an empty or missing directory, verifies every sha256, and
refuses to overwrite existing files. The trainer then resumes from last.pt exactly (model, optimizer, scheduler,
Python / torch / CUDA RNG, AMP scaler, epoch history, position); `paste.calibrate_full` resumes from its partial file.

    python -m paste.backup snapshot --run-dir DIR --run NAME [--prefix central] [--label manual]
    python -m paste.backup restore --run NAME --dest DIR [--prefix central] [--snapshot STAMP-LABEL]
    python -m paste.backup list [--prefix central] [--run NAME]
Token: HF_TOKEN in the environment, or a file named paste-hf-token under /kaggle/input (private Kaggle dataset).
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import shutil
import sys
import tempfile

REPO = os.environ.get("PASTE_BACKUP_REPO", "Awais1290/paste-checkpoints")
SKIP_SUFFIXES = (".tmp",)


def token():
    if os.environ.get("HF_TOKEN"):
        return os.environ["HF_TOKEN"]
    for p in glob.glob("/kaggle/input/**/paste-hf-token", recursive=True):
        return open(p).read().strip()
    return None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def _api():
    from huggingface_hub import HfApi
    tok = token()
    if not tok:
        raise SystemExit("no HF token (HF_TOKEN or /kaggle/input/**/paste-hf-token)")
    return HfApi(token=tok)


def _stage(run_dir, stage):
    files = []
    for root, _, names in os.walk(run_dir):
        for n in names:
            if n.endswith(SKIP_SUFFIXES):
                continue
            src = os.path.join(root, n)
            rel = os.path.relpath(src, run_dir)
            dst = os.path.join(stage, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            try:
                os.link(src, dst)                       # pins this version of the inode
            except OSError:
                shutil.copy2(src, dst)
            files.append(rel)
    return sorted(files)


def _resume_point(path):
    try:
        import torch
        st = torch.load(path, weights_only=False, map_location="cpu")
        return {"pos": st.get("pos"), "step": st.get("step"), "epochs_done": len(st.get("ep_hist", []))}
    except Exception as e:                              # informational only
        return {"error": type(e).__name__}


def snapshot(run_dir, run, prefix="central", label="auto", api=None, meta=None):
    """Upload one immutable snapshot of run_dir. Returns the manifest (dict)."""
    from huggingface_hub import CommitOperationAdd
    api = api or _api()
    base = f"{prefix}/{run}"
    with tempfile.TemporaryDirectory(dir=os.path.dirname(os.path.abspath(run_dir))) as stage:
        files = _stage(run_dir, stage)
        if not files:
            raise SystemExit(f"nothing to back up in {run_dir}")
        from huggingface_hub.errors import EntryNotFoundError
        try:
            existing = {e.path for e in api.list_repo_tree(REPO, path_in_repo=f"{base}/blobs")}
        except EntryNotFoundError:                       # first snapshot of this run
            existing = set()
        entries, ops = {}, []
        for rel in files:
            p = os.path.join(stage, rel)
            h = sha256(p)
            blob = f"{base}/blobs/{h[:16]}-{os.path.basename(rel)}"
            entries[rel] = {"blob": blob, "sha256": h, "size": os.path.getsize(p)}
            if blob not in existing:
                ops.append(CommitOperationAdd(path_in_repo=blob, path_or_fileobj=p))
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        name = f"{stamp}-{label}"
        man = {"run": run, "prefix": prefix, "snapshot": name, "created_utc": stamp, "label": label, "files": entries,
               "resume_point": _resume_point(os.path.join(stage, "last.pt")) if "last.pt" in entries else None,
               "meta": meta or {}}
        mp = os.path.join(stage, "MANIFEST.json")
        json.dump(man, open(mp, "w"), indent=1)
        ops.append(CommitOperationAdd(path_in_repo=f"{base}/snapshots/{name}/MANIFEST.json", path_or_fileobj=mp))
        api.create_commit(REPO, operations=ops, commit_message=f"backup {base} {name} ({len(ops) - 1} new blobs)")
    print(json.dumps({"snapshot": f"{base}/snapshots/{name}", "files": len(entries), "new_blobs": len(ops) - 1,
                      "resume_point": man["resume_point"]}), flush=True)
    return man


def snapshots(run, prefix="central", api=None):
    api = api or _api()
    from huggingface_hub.errors import EntryNotFoundError, RepositoryNotFoundError
    try:                                                # the listing is lazy: iterate inside the try
        return sorted(e.path.rsplit("/", 1)[-1] for e in api.list_repo_tree(REPO, path_in_repo=f"{prefix}/{run}/snapshots"))
    except (EntryNotFoundError, RepositoryNotFoundError):
        return []


def restore(run, dest, prefix="central", snapshot_name="latest", api=None):
    """Download a snapshot into dest (missing or empty), verifying every file. Returns the manifest."""
    from huggingface_hub import hf_hub_download
    api = api or _api()
    names = snapshots(run, prefix, api)
    if not names:
        raise SystemExit(f"no snapshots for {prefix}/{run}")
    name = names[-1] if snapshot_name == "latest" else snapshot_name
    mp = hf_hub_download(REPO, f"{prefix}/{run}/snapshots/{name}/MANIFEST.json", token=api.token)
    man = json.load(open(mp))
    os.makedirs(dest, exist_ok=True)
    clash = [r for r in man["files"] if os.path.exists(os.path.join(dest, r))]
    if clash:
        raise SystemExit(f"restore refuses to overwrite existing files in {dest}: {clash[:5]}")
    for rel, e in man["files"].items():
        p = hf_hub_download(REPO, e["blob"], token=api.token)
        if sha256(p) != e["sha256"]:
            raise SystemExit(f"sha256 mismatch for {rel}")
        out = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copyfile(p, out)
    print(json.dumps({"restored": f"{prefix}/{run}/snapshots/{name}", "files": len(man["files"]),
                      "resume_point": man.get("resume_point")}), flush=True)
    return man


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot"); s.add_argument("--run-dir", required=True); s.add_argument("--run", required=True)
    s.add_argument("--prefix", default="central"); s.add_argument("--label", default="manual")
    r = sub.add_parser("restore"); r.add_argument("--run", required=True); r.add_argument("--dest", required=True)
    r.add_argument("--prefix", default="central"); r.add_argument("--snapshot", default="latest")
    l = sub.add_parser("list"); l.add_argument("--prefix", default="central"); l.add_argument("--run")
    a = ap.parse_args()
    if a.cmd == "snapshot":
        snapshot(a.run_dir, a.run, a.prefix, a.label)
    elif a.cmd == "restore":
        restore(a.run, a.dest, a.prefix, a.snapshot)
    else:
        api = _api()
        runs = [a.run] if a.run else sorted({e.path.rsplit("/", 1)[-1] for e in api.list_repo_tree(REPO, path_in_repo=a.prefix)})
        for run in runs:
            print(run, snapshots(run, a.prefix, api))


if __name__ == "__main__":
    sys.exit(main())
