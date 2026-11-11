/**
 * The Strata stage on the Nocturne globe (design-direction.md): night-ink ocean, unclaimed land a step
 * lighter, hillshade relief above the territory fills, modern lakes and rivers, a faint coastline and
 * graticule, and the atmospheric rim. The basemap is modern Natural Earth physical geography, shown as
 * context only.
 */
import type { StyleSpecification } from "maplibre-gl";

export const TOKENS = {
  ink950: "#0d1014",
  ink900: "#10161e",
  ink800: "#1a222c",
  graphite: "#262c34",
  bone100: "#e9e2d2",
  bone400: "#b9b2a3",
  slate400: "#8d949d",
  slate500: "#6f7680",
} as const;

/** Layer the deck.gl territory fills are inserted beneath (relief, water and lines draw above them). */
export const TERRITORY_BEFORE = "relief";

function graticule(step = 15, densify = 2): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  for (let lon = -180; lon < 180; lon += step) {
    const coords: GeoJSON.Position[] = [];
    for (let lat = -75; lat <= 75; lat += densify) coords.push([lon, lat]);
    features.push({ type: "Feature", properties: { kind: lon === 0 ? "prime" : "meridian" }, geometry: { type: "LineString", coordinates: coords } });
  }
  for (let lat = -60; lat <= 60; lat += step) {
    const coords: GeoJSON.Position[] = [];
    for (let lon = -180; lon <= 180; lon += densify) coords.push([lon, lat]);
    features.push({ type: "Feature", properties: { kind: lat === 0 ? "equator" : "parallel" }, geometry: { type: "LineString", coordinates: coords } });
  }
  return { type: "FeatureCollection", features };
}

export interface BasemapData {
  land: GeoJSON.FeatureCollection;
  coastline: GeoJSON.FeatureCollection;
  lakes: GeoJSON.FeatureCollection;
  rivers: GeoJSON.FeatureCollection;
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function strataStyle(relief: { tiles: string; tileSize: number; minzoom: number; maxzoom: number } | null,
                            basemap: BasemapData | null, projection: "globe" | "mercator"): StyleSpecification {
  return {
    version: 8,
    projection: { type: projection },
    sky: {
      "sky-color": TOKENS.ink950,
      "horizon-color": "#22303f",
      "fog-color": TOKENS.ink950,
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.8,
      "fog-ground-blend": 0.9,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 4, 0.8, 7, 0],
    },
    sources: {
      land: { type: "geojson", data: basemap?.land ?? EMPTY, tolerance: 0.2 },
      coastline: { type: "geojson", data: basemap?.coastline ?? EMPTY, tolerance: 0.2 },
      lakes: { type: "geojson", data: basemap?.lakes ?? EMPTY, tolerance: 0.3 },
      rivers: { type: "geojson", data: basemap?.rivers ?? EMPTY, tolerance: 0.3 },
      graticule: { type: "geojson", data: graticule() },
      ...(relief ? { relief: { type: "raster", tiles: [relief.tiles], tileSize: relief.tileSize, minzoom: relief.minzoom,
                               maxzoom: relief.maxzoom } } : {}),
    },
    layers: [
      { id: "ocean", type: "background", paint: { "background-color": "#0e141b" } },
      { id: "land", type: "fill", source: "land", paint: { "fill-color": TOKENS.ink800, "fill-antialias": false } },
      ...(relief ? [{ id: "relief", type: "raster" as const, source: "relief",
                      paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.55, 3, 0.42, 6, 0.3] as never, "raster-fade-duration": 0 } }]
                 : [{ id: "relief", type: "background" as const, paint: { "background-opacity": 0 } }]),
      { id: "lakes", type: "fill", source: "lakes", filter: ["<=", ["get", "r"], ["+", 3, ["floor", ["zoom"]]]],
        paint: { "fill-color": "#0e141b", "fill-opacity": 0.92 } },
      { id: "rivers", type: "line", source: "rivers", filter: ["<=", ["get", "r"], ["+", 3, ["floor", ["zoom"]]]],
        paint: { "line-color": "#36506a", "line-opacity": 0.55,
                 "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.35, 6, 1.1] } },
      { id: "coastline", type: "line", source: "coastline",
        paint: { "line-color": TOKENS.bone400, "line-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.22, 6, 0.4],
                 "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 6, 1] } },
      { id: "graticule", type: "line", source: "graticule",
        paint: { "line-color": TOKENS.bone100,
                 "line-opacity": ["match", ["get", "kind"], ["equator", "prime"], 0.1, 0.05], "line-width": 0.6 } },
    ],
  };
}
