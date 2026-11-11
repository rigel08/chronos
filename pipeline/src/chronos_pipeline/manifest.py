"""Pinned inputs (data/manifest.lock.json) and verified, offline-reproducible fetching."""
from __future__ import annotations

import hashlib
import json
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

USER_AGENT = "CHRONOS-pipeline/0.1 (data fetch)"


class FetchError(RuntimeError):
    pass


@dataclass(frozen=True)
class Pin:
    source_id: str
    release: str
    url: str
    filename: str
    sha256: str
    archive: str | None = None
    members: dict[str, str] = field(default_factory=dict)
    retrieved_on: str | None = None
    generated_by: str | None = None    # snapshots we build ourselves (e.g. Wikidata); pinned once created


def load_manifest(path: Path) -> dict[str, Pin]:
    doc = json.loads(path.read_text())
    if doc.get("version") != 1:
        raise FetchError(f"{path}: unsupported manifest version {doc.get('version')!r}")
    return {sid: Pin(source_id=sid, release=d["release"], url=d["url"], filename=d["filename"], sha256=d["sha256"],
                     archive=d.get("archive"), members=dict(d.get("members", {})), retrieved_on=d.get("retrieved_on"),
                     generated_by=d.get("generated_by"))
            for sid, d in doc["sources"].items()}


def lock_generated(path: Path, source_id: str, release: str, url: str, filename: str, sha256: str,
                   generated_by: str) -> None:
    """Pin a snapshot we generated. Refuses to silently replace a different existing pin."""
    doc = json.loads(path.read_text())
    cur = doc["sources"].get(source_id)
    if cur and cur["sha256"] != sha256 and cur["release"] == release:
        raise FetchError(f"{source_id} {release} is already pinned with a different sha256; use a new release name")
    doc["sources"][source_id] = {"release": release, "url": url, "filename": filename, "sha256": sha256,
                                 "retrieved_on": release, "generated_by": generated_by}
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def release_dir(raw_root: Path, pin: Pin) -> Path:
    return raw_root / pin.source_id / pin.release


def member_path(raw_root: Path, pin: Pin, member: str) -> Path:
    return release_dir(raw_root, pin) / "members" / member


def _safe_member(name: str) -> PurePosixPath:
    p = PurePosixPath(name)
    if p.is_absolute() or ".." in p.parts:
        raise FetchError(f"refusing unsafe archive member path {name!r}")
    return p


def fetch(pin: Pin, raw_root: Path, from_file: Path | None = None) -> Path:
    """Place the pinned file under data/raw, verify its sha256, and extract only the pinned members.

    With `from_file`, a local copy is used instead of the network; it must have the pinned checksum.
    """
    dest_dir = release_dir(raw_root, pin)
    dest = dest_dir / pin.filename
    if not (dest.exists() and sha256_file(dest) == pin.sha256):
        dest_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=dest_dir, delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            if from_file is not None:
                shutil.copyfile(from_file, tmp_path)
            else:
                req = urllib.request.Request(pin.url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=300) as r, open(tmp_path, "wb") as out:
                    shutil.copyfileobj(r, out)
            got = sha256_file(tmp_path)
            if got != pin.sha256:
                raise FetchError(f"{pin.source_id}: sha256 mismatch for {pin.filename}: expected {pin.sha256}, got {got}")
            tmp_path.replace(dest)
        finally:
            tmp_path.unlink(missing_ok=True)
    _extract_members(pin, dest, raw_root)
    return dest


def _extract_members(pin: Pin, archive_path: Path, raw_root: Path) -> None:
    for name, expected in pin.members.items():
        target = member_path(raw_root, pin, str(_safe_member(name)))
        if target.exists() and sha256_file(target) == expected:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if pin.archive == "zip":
            with zipfile.ZipFile(archive_path) as z, z.open(name) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
        elif pin.archive == "tgz":
            with tarfile.open(archive_path, "r:gz") as t:
                member = t.getmember(name)
                if not member.isfile():
                    raise FetchError(f"{name}: not a regular file in archive")
                fobj = t.extractfile(member)
                if fobj is None:
                    raise FetchError(f"{name}: could not be read from the archive")
                with fobj, open(target, "wb") as out:
                    shutil.copyfileobj(fobj, out)
        else:
            raise FetchError(f"{pin.source_id}: members listed but archive type is {pin.archive!r}")
        got = sha256_file(target)
        if got != expected:
            target.unlink()
            raise FetchError(f"{pin.source_id}: member {name} sha256 mismatch: expected {expected}, got {got}")


def verified_member(raw_root: Path, pin: Pin, member: str) -> Path:
    """Path of a pinned member, after re-checking its checksum (builds never trust unverified files)."""
    path = member_path(raw_root, pin, member)
    if not path.exists():
        raise FetchError(f"{pin.source_id}: {member} missing; run `make fetch` first")
    if sha256_file(path) != pin.members[member]:
        raise FetchError(f"{pin.source_id}: {member} does not match its pinned sha256")
    return path


def verified_file(raw_root: Path, pin: Pin) -> Path:
    path = release_dir(raw_root, pin) / pin.filename
    if not path.exists():
        raise FetchError(f"{pin.source_id}: {pin.filename} missing; run `make fetch` first")
    if sha256_file(path) != pin.sha256:
        raise FetchError(f"{pin.source_id}: {pin.filename} does not match its pinned sha256")
    return path
