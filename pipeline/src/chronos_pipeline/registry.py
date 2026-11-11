"""Licence and source registry, and the build-time licence gate (D-007, D-010, QA-012)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import yaml

TIERS = ("public", "research_only")
PROFILES = ("public", "research")


class RegistryError(ValueError):
    """The registry is inconsistent (unknown licence, NC source marked public without permission...)."""


class LicenceGateError(RuntimeError):
    """QA-012: a research-only source was about to enter a public artifact."""


@dataclass(frozen=True)
class License:
    id: str
    name: str
    attribution_required: bool
    share_alike: bool
    commercial_use: bool
    url: str | None = None
    notes: str | None = None


@dataclass(frozen=True)
class Source:
    id: str
    kind: str
    title: str
    license: str
    citation: str
    access_tier: str = "research_only"
    adapter: str | None = None
    authors: tuple[str, ...] = ()
    url: str | None = None
    doi: str | None = None


@dataclass(frozen=True)
class Permission:
    source_id: str
    granted_by: str
    scope: str
    document_ref: str
    granted_on: date
    expires_on: date | None = None

    def active(self, today: date) -> bool:
        return self.granted_on <= today and (self.expires_on is None or today <= self.expires_on)


@dataclass(frozen=True)
class Registry:
    licenses: dict[str, License]
    sources: dict[str, Source]
    permissions: tuple[Permission, ...] = field(default=())

    def license_of(self, source_id: str) -> License:
        return self.licenses[self.sources[source_id].license]

    def is_public(self, source_id: str) -> bool:
        return self.sources[source_id].access_tier == "public"

    def check_profile(self, profile: str, source_ids: list[str]) -> None:
        """Raise LicenceGateError if `profile` may not contain every source in `source_ids` (QA-012)."""
        if profile not in PROFILES:
            raise ValueError(f"unknown build profile {profile!r}; expected one of {PROFILES}")
        unknown = [s for s in source_ids if s not in self.sources]
        if unknown:
            raise LicenceGateError(f"QA-012: sources not in the registry cannot enter any build: {unknown}")
        if profile == "public":
            blocked = [s for s in source_ids if not self.is_public(s)]
            if blocked:
                raise LicenceGateError(
                    f"QA-012: research-only sources cannot enter the public profile: {blocked}. "
                    "Record a permission in permissions.yaml or obtain a suitable licence (D-010).")


def _load_yaml_list(path: Path) -> list[dict]:
    data = yaml.safe_load(path.read_text()) or []
    if not isinstance(data, list):
        raise RegistryError(f"{path.name}: expected a list")
    return data


def load_registry(registry_dir: Path, today: date | None = None) -> Registry:
    today = today or date.today()
    licenses = {}
    for d in _load_yaml_list(registry_dir / "licenses.yaml"):
        lic = License(id=d["id"], name=d["name"], attribution_required=bool(d["attribution_required"]),
                      share_alike=bool(d["share_alike"]), commercial_use=bool(d["commercial_use"]),
                      url=d.get("url"), notes=d.get("notes"))
        if lic.id in licenses:
            raise RegistryError(f"duplicate licence id {lic.id}")
        licenses[lic.id] = lic

    permissions = tuple(
        Permission(source_id=d["source_id"], granted_by=d["granted_by"], scope=d["scope"],
                   document_ref=d["document_ref"], granted_on=_as_date(d["granted_on"]),
                   expires_on=_as_date(d["expires_on"]) if d.get("expires_on") else None)
        for d in _load_yaml_list(registry_dir / "permissions.yaml"))

    sources = {}
    for d in _load_yaml_list(registry_dir / "sources.yaml"):
        tier = d.get("access_tier", "research_only")
        src = Source(id=d["id"], kind=d["kind"], title=d["title"], license=d["license"], citation=d["citation"],
                     access_tier=tier, adapter=d.get("adapter"), authors=tuple(d.get("authors", ())),
                     url=d.get("url"), doi=d.get("doi"))
        if src.id in sources:
            raise RegistryError(f"duplicate source id {src.id}")
        if src.license not in licenses:
            raise RegistryError(f"source {src.id}: unknown licence {src.license!r}")
        if tier not in TIERS:
            raise RegistryError(f"source {src.id}: access_tier must be one of {TIERS}, got {tier!r}")
        lic = licenses[src.license]
        if tier == "public" and not lic.commercial_use:
            if not any(p.source_id == src.id and p.active(today) for p in permissions):
                raise RegistryError(
                    f"source {src.id}: licence {lic.id} does not allow commercial use, so it cannot be public "
                    "without an active permission in permissions.yaml (D-010)")
        sources[src.id] = src
    return Registry(licenses=licenses, sources=sources, permissions=permissions)


def _as_date(v: object) -> date:
    return v if isinstance(v, date) else date.fromisoformat(str(v))
