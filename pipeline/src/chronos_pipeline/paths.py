"""Repository locations. Everything is relative to the repo root, overridable for tests."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def repo_root() -> Path:
    env = os.environ.get("CHRONOS_ROOT")
    if env:
        return Path(env).resolve()
    # src/chronos_pipeline/paths.py -> pipeline/src/chronos_pipeline -> repo root is parents[3]
    return Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Paths:
    root: Path

    @property
    def registry(self) -> Path:
        return self.root / "pipeline" / "registry"

    @property
    def data(self) -> Path:
        return self.root / "data"

    @property
    def manifest(self) -> Path:
        return self.data / "manifest.lock.json"

    @property
    def raw(self) -> Path:
        return self.data / "raw"

    @property
    def build(self) -> Path:
        return self.data / "build"

    @classmethod
    def default(cls) -> Paths:
        return cls(repo_root())
