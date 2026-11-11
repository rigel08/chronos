"""Polity colours that separate neighbours (milestone 1.3, D-027).

Colours carry no meaning: they exist so that polities which touch while both are mapped look different.
Each polity keeps one colour for its whole life, so continuity across rows stays visible. Lineage colour
families (design-direction.md) replace this once lineage data exists.

The assignment is DSatur graph colouring on the polity neighbour graph, weighted by shared years. The vertex
with the most distinct neighbour colours goes first. It takes the colour with the lowest cost, where a
neighbour costs its weight times the perceptual similarity of the two colours (1 for the same colour, falling
to 0 at OKLab distance `distinct_at`), then the least used colour, then the lowest index. Deterministic.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np


def oklab(hex_colour: str) -> np.ndarray:
    rgb = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    r, g, b = (c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb)
    lms = np.cbrt([0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
                   0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
                   0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b])
    m = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                  [1.9779984951, -2.4285922050, 0.4505937099],
                  [0.0259040371, 0.7827717662, -0.8086757660]])
    return m @ lms


def similarity(palette: list[str], distinct_at: float) -> np.ndarray:
    lab = np.array([oklab(h) for h in palette])
    d = np.linalg.norm(lab[:, None, :] - lab[None, :, :], axis=-1)
    s = np.clip(1.0 - d / distinct_at, 0.0, 1.0)
    np.fill_diagonal(s, 1.0)
    return s


SAME_COLOUR_PENALTY = 4.0       # an identical neighbour costs this many times the most similar distinct one


def assign_colours(polity_ids: list[str], weights: dict[tuple[str, str], int], palette: list[str],
                   distinct_at: float) -> tuple[dict[str, int], dict]:
    k = len(palette)
    sim = similarity(palette, distinct_at)
    penalty = sim + np.eye(k) * (SAME_COLOUR_PENALTY - 1.0)
    adj: dict[str, dict[str, int]] = defaultdict(dict)
    for (p, q), w in weights.items():
        adj[p][q] = adj[p].get(q, 0) + w
        adj[q][p] = adj[q].get(p, 0) + w
    degree = {p: sum(adj[p].values()) for p in polity_ids}
    colour: dict[str, int] = {}
    used = [0] * k
    remaining = set(polity_ids)
    sat: dict[str, set[int]] = defaultdict(set)
    while remaining:
        v = min(remaining, key=lambda p: (-len(sat[p]), -degree[p], p))
        cost = np.zeros(k)
        for q, w in adj[v].items():
            if q in colour:
                cost += w * penalty[:, colour[q]]
        c = min(range(k), key=lambda i: (round(float(cost[i]), 6), used[i], i))
        colour[v] = c
        used[c] += 1
        remaining.discard(v)
        for q in adj[v]:
            sat[q].add(c)
    # Local improvement: move a vertex to the colour with the lowest neighbour cost while that strictly helps.
    for _ in range(20):
        moved = 0
        for v in sorted(polity_ids):
            cost = np.zeros(k)
            for q, w in adj[v].items():
                cost += w * penalty[:, colour[q]]
            best = min(range(k), key=lambda i: (round(float(cost[i]), 6), i))
            if cost[best] < cost[colour[v]] - 1e-9:
                used[colour[v]] -= 1
                used[best] += 1
                colour[v] = best
                moved += 1
        if not moved:
            break
    same = [(p, q, w) for (p, q), w in weights.items() if colour.get(p) == colour.get(q)]
    close = [(p, q, w) for (p, q), w in weights.items()
             if colour.get(p) != colour.get(q) and sim[colour[p], colour[q]] > 0]
    stats = {"colours": k, "polities": len(polity_ids), "neighbour_pairs": len(weights),
             "same_colour_pairs": len(same), "same_colour_shared_years": sum(w for *_, w in same),
             "similar_colour_pairs": len(close), "total_shared_years": sum(weights.values()),
             "min_palette_distance_oklab": round(float(np.min(np.linalg.norm(
                 np.array([oklab(h) for h in palette])[:, None] - np.array([oklab(h) for h in palette])[None], axis=-1)
                 + np.eye(k) * 9)), 4),
             "worst_same_colour": [list(c) for c in sorted(same, key=lambda c: (-c[2], c[0], c[1]))[:10]],
             "usage": used}
    return colour, stats
