"""Year convention (QA-001), licence registry and gate (D-010, QA-012), pinned fetching (D-013)."""
from __future__ import annotations

import io
import json
import zipfile
from datetime import date
from pathlib import Path

import pytest

from chronos_pipeline.manifest import FetchError, Pin, fetch, sha256_file, verified_member
from chronos_pipeline.registry import LicenceGateError, RegistryError, load_registry
from chronos_pipeline.years import cliopatria_to_astronomical, label

REG = Path(__file__).resolve().parents[1] / "registry"


# ------------------------------------------------------------------ years
@pytest.mark.parametrize("src, astro", [(-31, -30), (-1, 0), (0, 0), (1, 1), (-3400, -3399), (2024, 2024)])
def test_cliopatria_years_map_to_astronomical(src, astro):
    assert cliopatria_to_astronomical(src) == astro


def test_rows_ending_at_zero_abut_rows_starting_at_one():
    # Roman Empire in Cliopatria: (-14, 0) then (1, 5). Contiguous after mapping.
    assert cliopatria_to_astronomical(1) == cliopatria_to_astronomical(0) + 1


@pytest.mark.parametrize("astro, text", [(0, "1 BCE"), (-30, "31 BCE"), (1, "1 CE"), (117, "117 CE"), (-499, "500 BCE")])
def test_labels(astro, text):
    assert label(astro) == text


# ------------------------------------------------------------------ registry and licence gate
def _registry_dir(tmp_path: Path, sources: str, permissions: str = "[]") -> Path:
    d = tmp_path / "reg"
    d.mkdir()
    (d / "licenses.yaml").write_text((REG / "licenses.yaml").read_text())
    (d / "sources.yaml").write_text(sources)
    (d / "permissions.yaml").write_text(permissions)
    return d


def test_real_registry_loads_and_nc_sources_are_research_only():
    reg = load_registry(REG)
    for sid in ("seshat-equinox", "cshapes-2", "smithsonian-gvp"):
        assert reg.sources[sid].access_tier == "research_only"
        assert not reg.license_of(sid).commercial_use
    for sid in ("cliopatria", "natural-earth-land", "wikidata", "chronos-editorial"):
        assert reg.is_public(sid)


def test_missing_access_tier_defaults_to_research_only(tmp_path):
    d = _registry_dir(tmp_path, "- {id: x, kind: dataset, title: X, license: CC-BY-4.0, citation: X}\n")
    assert load_registry(d).sources["x"].access_tier == "research_only"


def test_nc_source_cannot_be_public_without_permission(tmp_path):
    d = _registry_dir(tmp_path, "- {id: eq, kind: dataset, title: E, license: CC-BY-NC-SA-4.0, citation: E, access_tier: public}\n")
    with pytest.raises(RegistryError, match="cannot be public"):
        load_registry(d)


def test_active_permission_allows_public_nc_source(tmp_path):
    d = _registry_dir(tmp_path,
                      "- {id: eq, kind: dataset, title: E, license: CC-BY-NC-SA-4.0, citation: E, access_tier: public}\n",
                      "- {source_id: eq, granted_by: Seshat, scope: public app, document_ref: mail-1, granted_on: 2026-01-01}\n")
    assert load_registry(d, today=date(2026, 6, 1)).is_public("eq")


def test_expired_permission_does_not_count(tmp_path):
    d = _registry_dir(tmp_path,
                      "- {id: eq, kind: dataset, title: E, license: CC-BY-NC-SA-4.0, citation: E, access_tier: public}\n",
                      "- {source_id: eq, granted_by: S, scope: s, document_ref: d, granted_on: 2025-01-01, expires_on: 2025-12-31}\n")
    with pytest.raises(RegistryError):
        load_registry(d, today=date(2026, 6, 1))


def test_unknown_licence_is_rejected(tmp_path):
    d = _registry_dir(tmp_path, "- {id: x, kind: dataset, title: X, license: Made-Up, citation: X}\n")
    with pytest.raises(RegistryError, match="unknown licence"):
        load_registry(d)


def test_gate_blocks_research_only_source_from_public_profile():
    reg = load_registry(REG)
    with pytest.raises(LicenceGateError, match="QA-012"):
        reg.check_profile("public", ["cliopatria", "seshat-equinox"])
    reg.check_profile("research", ["cliopatria", "seshat-equinox"])     # allowed locally
    reg.check_profile("public", ["cliopatria", "wikidata"])             # allowed


def test_gate_blocks_unregistered_sources_everywhere():
    reg = load_registry(REG)
    for profile in ("public", "research"):
        with pytest.raises(LicenceGateError):
            reg.check_profile(profile, ["not-registered"])


# ------------------------------------------------------------------ pinned fetch
def _zip(member: str, data: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(member, data)
    return buf.getvalue()


def _pin(tmp_path: Path, zbytes: bytes, member: str, data: bytes) -> tuple[Pin, Path]:
    import hashlib
    src = tmp_path / "in.zip"
    src.write_bytes(zbytes)
    pin = Pin("s", "v1", "test://", "s.zip", hashlib.sha256(zbytes).hexdigest(), "zip",
              {member: hashlib.sha256(data).hexdigest()})
    return pin, src


def test_fetch_from_file_verifies_and_extracts(tmp_path):
    data = json.dumps({"ok": True}).encode()
    pin, src = _pin(tmp_path, _zip("a.json", data), "a.json", data)
    fetch(pin, tmp_path / "raw", from_file=src)
    assert verified_member(tmp_path / "raw", pin, "a.json").read_bytes() == data


def test_fetch_rejects_wrong_checksum_and_leaves_nothing(tmp_path):
    data = b"x"
    pin, src = _pin(tmp_path, _zip("a.json", data), "a.json", data)
    bad = tmp_path / "bad.zip"
    bad.write_bytes(_zip("a.json", b"tampered"))
    with pytest.raises(FetchError, match="sha256 mismatch"):
        fetch(pin, tmp_path / "raw", from_file=bad)
    assert not (tmp_path / "raw" / "s" / "v1" / "s.zip").exists()
    assert not [p for p in (tmp_path / "raw" / "s" / "v1").iterdir() if p.is_file()]


def test_modified_member_is_detected_before_build(tmp_path):
    data = b"payload"
    pin, src = _pin(tmp_path, _zip("a.json", data), "a.json", data)
    fetch(pin, tmp_path / "raw", from_file=src)
    path = verified_member(tmp_path / "raw", pin, "a.json")
    path.write_bytes(b"edited by hand")
    with pytest.raises(FetchError, match="does not match"):
        verified_member(tmp_path / "raw", pin, "a.json")


def test_unsafe_member_paths_are_refused(tmp_path):
    data = b"x"
    pin, src = _pin(tmp_path, _zip("../evil.json", data), "../evil.json", data)
    with pytest.raises(FetchError, match="unsafe"):
        fetch(pin, tmp_path / "raw", from_file=src)


def test_sha256_file_streams(tmp_path):
    p = tmp_path / "f"
    p.write_bytes(b"abc")
    assert sha256_file(p) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
