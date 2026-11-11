"""chronos-pipeline: fetch | verify | snapshot-wikidata | build | core-sample."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .manifest import (
    FetchError,
    fetch,
    load_manifest,
    lock_generated,
    sha256_file,
    verified_file,
    verified_member,
)
from .paths import Paths


def cmd_fetch(paths: Paths, args: argparse.Namespace) -> int:
    pins = load_manifest(paths.manifest)
    targets = [args.source] if args.source else [s for s, p in pins.items() if not p.generated_by]
    for sid in targets:
        pin = pins[sid]
        if pin.generated_by:
            print(f"{sid}: generated snapshot ({pin.generated_by}); nothing to download")
            continue
        dest = fetch(pin, paths.raw, Path(args.from_file) if args.from_file else None)
        print(f"{sid} {pin.release}: {dest.relative_to(paths.root)} verified ({len(pin.members)} members)")
    return 0


def cmd_verify(paths: Paths, _: argparse.Namespace) -> int:
    ok = True
    for sid, pin in load_manifest(paths.manifest).items():
        try:
            verified_file(paths.raw, pin)
            for m in pin.members:
                verified_member(paths.raw, pin, m)
            print(f"OK    {sid} {pin.release}")
        except FetchError as e:
            ok = False
            print(f"FAIL  {sid}: {e}")
    return 0 if ok else 1


def cmd_snapshot(paths: Paths, args: argparse.Namespace) -> int:
    from .sources.cliopatria import read_rows, split_aggregates
    from .sources.wikidata import ENDPOINT, build_snapshot, write_snapshot
    pins = load_manifest(paths.manifest)
    base, _ = split_aggregates(read_rows(verified_member(paths.raw, pins["cliopatria"],
                                                         "cliopatria_polities_only_v021.geojson")))
    qids = sorted({q for r in base for q in r.wikidata})
    snap = build_snapshot(qids, args.date)
    target = paths.raw / "wikidata" / args.date / "snapshot.json"
    write_snapshot(snap, target)
    digest = sha256_file(target)
    print(f"{len(qids)} QIDs -> {target.relative_to(paths.root)} sha256 {digest}")
    if args.lock:
        lock_generated(paths.manifest, "wikidata", args.date, ENDPOINT, "snapshot.json", digest,
                       "chronos-pipeline snapshot-wikidata")
        print("pinned in data/manifest.lock.json")
    return 0


def cmd_build(paths: Paths, args: argparse.Namespace) -> int:
    from .build import run
    out = run(paths, profile=args.profile)
    print(out.relative_to(paths.root))
    return 0


def cmd_core_sample(paths: Paths, args: argparse.Namespace) -> int:
    import yaml

    from .core_sample import PointIndex
    from .sources.cliopatria import assign_identities, read_rows, split_aggregates
    cfg = yaml.safe_load((paths.registry / "build.yaml").read_text())
    pins = load_manifest(paths.manifest)
    base, aggs = split_aggregates(read_rows(verified_member(paths.raw, pins["cliopatria"],
                                                           "cliopatria_polities_only_v021.geojson")))
    polities, _ = assign_identities(base, aggs, **cfg["identity"])
    idx = PointIndex(base, {ri: (p.id, p.name) for p in polities for ri in p.rows})
    print(json.dumps(idx.sample(args.lon, args.lat, args.tolerance_km).as_dict(), indent=1, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="chronos-pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="download (or copy) pinned inputs into data/raw and verify them")
    f.add_argument("--source")
    f.add_argument("--from-file", help="use a local copy instead of the network (must match the pinned sha256)")
    sub.add_parser("verify", help="re-check every pinned input against its sha256")
    s = sub.add_parser("snapshot-wikidata", help="query Wikidata once for every asserted QID (network)")
    s.add_argument("--date", required=True)
    s.add_argument("--lock", action="store_true", help="pin the snapshot in the manifest")
    b = sub.add_parser("build", help="run QA and write the licence-gated bundle")
    b.add_argument("--profile", choices=["public", "research"], default="public")
    c = sub.add_parser("core-sample", help="every polity that held a point")
    c.add_argument("--lon", type=float, required=True)
    c.add_argument("--lat", type=float, required=True)
    c.add_argument("--tolerance-km", type=float, default=5.0)
    args = ap.parse_args(argv)
    paths = Paths.default()
    handlers = {"fetch": cmd_fetch, "verify": cmd_verify, "snapshot-wikidata": cmd_snapshot, "build": cmd_build,
                "core-sample": cmd_core_sample}
    try:
        return handlers[args.cmd](paths, args)
    except FetchError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
