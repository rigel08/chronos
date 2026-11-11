/**
 * Hides line and point layers on the far side of the globe. Polygon fills rely on back-face culling (D-022),
 * but lines and points have no faces: without this, a selected polity's outline would show through the Earth.
 * Globe common space is centred on the Earth's centre (radius 256), so a point is visible when the camera is on
 * its side of the tangent plane.
 */
import { LayerExtension } from "@deck.gl/core";

const farSide = {
  name: "farside",
  vs: "out float farside_visible;\n",
  fs: "in float farside_visible;\n",
  inject: {
    "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
    farside_visible = 1.0;
    if (project.projectionMode == PROJECTION_MODE_GLOBE) {
      vec3 p_ = project_globe_(vec3(geometry.worldPosition.xy, 0.0));
      farside_visible = dot(p_, project.cameraPosition - p_) > 0.0 ? 1.0 : 0.0;
    }
    `,
    "fs:DECKGL_FILTER_COLOR": "if (farside_visible < 0.5) discard;",
  },
};

export class FarSideExtension extends LayerExtension {
  static override extensionName = "FarSideExtension";
  override getShaders() {
    return { modules: [farSide] };
  }
}
