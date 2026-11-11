/**
 * StrataExtension (milestone 1.3): time visibility, dissolve, selection and overlap stripes on the GPU.
 *
 * Per vertex: `strataTime` = [start, end] (inclusive astronomical years) and either `strataCode`
 * (polity * 16 + palette index) for territory fills, or `strataCodes` (up to four codes, -1 padded) for
 * overlap regions. Uniforms carry the current and previous year, the dissolve progress, and the selected and
 * hovered polity. Changing any of them is a uniform update: no attribute is rebuilt or re-uploaded.
 *
 * Rules kept from 1.2:
 *   - exact years: a vertex is visible at t iff start <= t <= end (±0.5 margins on integer years, D-003);
 *   - the dissolve runs over wall-clock time between two attested states (D-020): it never shows a polity in a
 *     year it is not valid once finished, and picking always uses the current year only;
 *   - no soft year ranges.
 */
import { type Layer, LayerExtension } from "@deck.gl/core";

export interface StrataExtensionProps {
  /** [current year, previous year, dissolve progress 0..1]. */
  strataYears?: [number, number, number];
  strataSelected?: number;
  strataHovered?: number;
  /** Stripe width in pixels and pixels per degree at the current zoom (overlap layer). */
  strataStripes?: [number, number];
  /** 0..1: how strongly non-selected polities recede while one is selected. */
  strataDim?: number;
}

const defaultProps = {
  getStrataTime: { type: "accessor", value: [0, 0] },
  getStrataCode: { type: "accessor", value: 0 },
  getStrataCodes: { type: "accessor", value: [-1, -1, -1, -1] },
  strataYears: { type: "array", value: [0, 0, 1], compare: true },
  strataSelected: -1,
  strataHovered: -1,
  strataStripes: { type: "array", value: [7, 1], compare: true },
  strataDim: 0.62,
};

function rgb(hex: string): string {
  const n = (i: number) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4);
  return `vec3(${n(1)}, ${n(3)}, ${n(5)})`;
}

function shaderModule(name: string, palette: string[], stripes: boolean, wash: number) {
  const block = /* glsl */ `\
layout(std140) uniform ${name}Uniforms {
  float tCur;
  float tPrev;
  float mixT;
  float selected;
  float hovered;
  float stripePx;
  float pxPerDeg;
  float dim;
} ${name};
`;
  const vs = /* glsl */ `${block}
in vec2 strataTime;
${stripes ? "in vec4 strataCodes;\nflat out vec4 strata_vCodes;\nout vec2 strata_vLngLat;" : "in float strataCode;\nflat out float strata_vCode;"}
out float strata_vAlpha;
`;
  const n = palette.length;
  const fs = /* glsl */ `${block}
in float strata_vAlpha;
${stripes ? "flat in vec4 strata_vCodes;\nin vec2 strata_vLngLat;" : "flat in float strata_vCode;"}
const vec3 STRATA_PALETTE[${n}] = vec3[${n}](${palette.map(rgb).join(", ")});
vec3 strata_shade(float code) {
  float pol = floor(code / 16.0);
  int ci = int(mod(code, 16.0) + 0.5);
  vec3 c = mix(STRATA_PALETTE[clamp(ci, 0, ${n - 1})], vec3(0.051, 0.063, 0.078), ${wash.toFixed(3)});
  bool sel = ${name}.selected >= 0.0 && abs(pol - ${name}.selected) < 0.5;
  bool hov = ${name}.hovered >= 0.0 && abs(pol - ${name}.hovered) < 0.5;
  if (${name}.selected >= 0.0 && !sel) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(l) * 0.62, ${name}.dim);
  }
  if (hov && !sel) c = mix(c, vec3(1.0), 0.16);
  if (sel) c = mix(c, vec3(1.0), 0.08);
  return c;
}
`;
  const inject: Record<string, string> = {
    "vs:#main-start": /* glsl */ `
    {
      float s_ = strataTime.x;
      float e_ = strataTime.y;
      bool inCur = s_ <= ${name}.tCur + 0.5 && e_ >= ${name}.tCur - 0.5;
      bool inPrev = s_ <= ${name}.tPrev + 0.5 && e_ >= ${name}.tPrev - 0.5;
      float a_ = inCur ? (inPrev ? 1.0 : ${name}.mixT) : (inPrev ? 1.0 - ${name}.mixT : 0.0);
      if (picking.isActive > 0.5) a_ = inCur ? 1.0 : 0.0;
      strata_vAlpha = a_;
      ${stripes ? "strata_vCodes = strataCodes;" : "strata_vCode = strataCode;"}
    }
    `,
    "vs:#main-end": /* glsl */ `
    if (strata_vAlpha <= 0.0) {
      gl_Position = vec4(0.);
    }
    `,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
    if (strata_vAlpha <= 0.0) discard;
    if (picking.isActive < 0.5) {
      ${stripes ? `
      float n_ = 1.0 + float(strata_vCodes.y >= 0.0) + float(strata_vCodes.z >= 0.0) + float(strata_vCodes.w >= 0.0);
      float u_ = (strata_vLngLat.x * cos(radians(strata_vLngLat.y)) + strata_vLngLat.y) * ${name}.pxPerDeg / ${name}.stripePx;
      float k_ = mod(floor(u_), n_);
      float code_ = k_ < 0.5 ? strata_vCodes.x : (k_ < 1.5 ? strata_vCodes.y : (k_ < 2.5 ? strata_vCodes.z : strata_vCodes.w));
      ` : "float code_ = strata_vCode;"}
      color = vec4(strata_shade(code_), color.a * strata_vAlpha);
    }
    `,
  };
  if (stripes) inject["vs:DECKGL_FILTER_GL_POSITION"] = "strata_vLngLat = geometry.worldPosition.xy;";
  return {
    name,
    vs,
    fs,
    inject,
    uniformTypes: { tCur: "f32", tPrev: "f32", mixT: "f32", selected: "f32", hovered: "f32", stripePx: "f32", pxPerDeg: "f32", dim: "f32" },
    getUniforms: (opts?: Record<string, number>) => opts ?? {},
  } as const;
}

type StrataLayer = Layer<StrataExtensionProps & Record<string, unknown>>;

export class StrataExtension extends LayerExtension<{ palette: string[]; stripes: boolean; wash?: number }> {
  static override extensionName = "StrataExtension";
  static override defaultProps = defaultProps;

  private module: ReturnType<typeof shaderModule>;

  constructor(opts: { palette: string[]; stripes: boolean; wash?: number }) {
    super(opts);
    this.module = shaderModule(opts.stripes ? "strataStripes" : "strataFill", opts.palette, opts.stripes, opts.wash ?? 0.14);
  }

  override getShaders(this: StrataLayer, extension: StrataExtension) {
    return { modules: [extension.module] };
  }

  override initializeState(this: StrataLayer, _context: unknown, extension: StrataExtension) {
    const am = this.getAttributeManager();
    if (!am) return;
    am.add({ strataTime: { size: 2, type: "float32", stepMode: "dynamic", accessor: "getStrataTime" } });
    if (extension.opts.stripes) am.add({ strataCodes: { size: 4, type: "float32", stepMode: "dynamic", accessor: "getStrataCodes" } });
    else am.add({ strataCode: { size: 1, type: "float32", stepMode: "dynamic", accessor: "getStrataCode" } });
  }

  override draw(this: StrataLayer, _params: unknown, extension: StrataExtension) {
    const p = this.props;
    const [tCur, tPrev, mixT] = p.strataYears ?? [0, 0, 1];
    const [stripePx, pxPerDeg] = p.strataStripes ?? [7, 1];
    this.setShaderModuleProps({
      [extension.module.name]: { tCur, tPrev, mixT, selected: p.strataSelected ?? -1, hovered: p.strataHovered ?? -1,
                                 stripePx, pxPerDeg, dim: p.strataDim ?? 0.62 },
    });
  }
}
