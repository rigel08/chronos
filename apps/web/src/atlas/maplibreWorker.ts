/**
 * MapLibre 6 creates its web worker from a URL computed at run time, which a bundler cannot see, so a production
 * build would not emit the worker file ("Worker failed to load"). Vite builds it as its own entry here and MapLibre
 * is told where it is. Import this module before creating any map.
 */
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
