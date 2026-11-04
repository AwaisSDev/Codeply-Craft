"""paste.backup.token(): env first; a Kaggle dataset directory named like the token file is not mistaken for it."""
import os

from paste import backup


def test_token_skips_directory(tmp_path, monkeypatch):
    d = tmp_path / "input" / "datasets" / "u" / "paste-hf-token"
    d.mkdir(parents=True)
    (d / "paste-hf-token").write_text("tok123\n")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    real_glob = backup.glob.glob
    monkeypatch.setattr(backup.glob, "glob", lambda pat, recursive=False: real_glob(pat.replace("/kaggle/input", str(tmp_path / "input")), recursive=recursive))
    assert backup.token() == "tok123"
    monkeypatch.setenv("HF_TOKEN", "envtok")
    assert backup.token() == "envtok"
