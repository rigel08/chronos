/**
 * The view as a URL hash, so every moment is a shareable link (architecture §7):
 *   #t=117&c=30.000,30.000,1.40&p=roman-empire&s=12.4964,41.9028&proj=globe
 * Unknown or malformed parts are ignored, never guessed.
 */
export interface ViewState {
  t?: number;
  center?: [number, number];
  zoom?: number;
  polity?: string;
  sample?: [number, number];
  projection?: "globe" | "flat";
}

const num = (s: string | null | undefined): number | undefined => {
  if (s == null || s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

export function parseHash(hash: string): ViewState {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const out: ViewState = {};
  const t = num(q.get("t"));
  if (t !== undefined && Number.isInteger(t)) out.t = t;
  const c = (q.get("c") ?? "").split(",").map(num);
  if (c.length === 3 && c.every((x) => x !== undefined)) {
    const [lon, lat, z] = c as [number, number, number];
    if (Math.abs(lat) <= 90 && z >= 0 && z <= 22) {
      out.center = [((((lon + 180) % 360) + 360) % 360) - 180, lat];
      out.zoom = z;
    }
  }
  const p = q.get("p");
  if (p && /^[a-z0-9@\-_.]+$/i.test(p)) out.polity = p;
  const s = (q.get("s") ?? "").split(",").map(num);
  if (s.length === 2 && s.every((x) => x !== undefined)) {
    const [lon, lat] = s as [number, number];
    if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) out.sample = [lon, lat];
  }
  const proj = q.get("proj");
  if (proj === "globe" || proj === "flat") out.projection = proj;
  return out;
}

export function formatHash(v: ViewState): string {
  const parts: string[] = [];
  if (v.t !== undefined) parts.push(`t=${v.t}`);
  if (v.center && v.zoom !== undefined) parts.push(`c=${v.center[0].toFixed(3)},${v.center[1].toFixed(3)},${v.zoom.toFixed(2)}`);
  if (v.polity) parts.push(`p=${encodeURIComponent(v.polity)}`);
  if (v.sample) parts.push(`s=${v.sample[0].toFixed(4)},${v.sample[1].toFixed(4)}`);
  if (v.projection && v.projection !== "globe") parts.push(`proj=${v.projection}`);
  return `#${parts.join("&")}`;
}
