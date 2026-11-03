/**
 * Cells as one draw, on WebGL: every cell's rectangle in a box or a loop
 * row (a grid's 3,600, a heatmap's colors, a row's array) drawn as one
 * instanced quad mesh, instead of a Graphics each that PixiJS batches into
 * triangles on the processor every time the scene changes.
 *
 * Each instance is a cell: its rectangle, corner radius, stroke width,
 * opacity, fill and stroke colors (40 bytes). One quad is drawn per
 * instance and the fragment shader draws the rounded rectangle from its
 * distance to the edge, anti-aliased by a pixel at whatever the zoom, the
 * stroke centered on the edge (as SVG strokes it) over the fill. So a
 * million cells are one draw call and 40 MB, uploaded once.
 *
 * A cell's text, flash and animation stay with its layer (pixiScene.ts):
 * `sync` reads each cell's layer (where the step animation has slid it,
 * how far it has faded in) into its instance, before each frame drawn.
 *
 * Canvas 2D has no shaders: there each cell is a Graphics as before.
 */
import { Bounds, Buffer, BufferUsage, type Container, Geometry, GlProgram, Mesh, Rectangle, Shader } from "pixi.js";
import type { CellBatch, CellRect } from "./pixiScene";

/** Floats per instance: rect (4), shape (3: radius, stroke width, opacity), fill and stroke as packed RGBA8. */
const STRIDE = 9;

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec4 aRect;
in vec3 aShape;
in vec4 aFill;
in vec4 aStroke;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec2 uResolution;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

out vec2 vLocal;
out vec4 vRect;
out vec2 vShape;
out vec4 vFill;
out vec4 vStroke;
out float vPx;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  // How long a pixel is, in the mesh's own units (for the anti-aliasing, and the quad's margin for it).
  vec2 perUnit = (mvp * vec3(1.0, 0.0, 0.0)).xy * uResolution * 0.5;
  float px = 1.0 / max(length(perUnit), 1e-6);
  float grow = aShape.y * 0.5 + px * 1.5;
  vec2 local = aRect.xy - grow + aPosition * (aRect.zw + 2.0 * grow);
  gl_Position = vec4((mvp * vec3(local, 1.0)).xy, 0.0, 1.0);
  vLocal = local;
  vRect = aRect;
  vShape = aShape.xy;
  vPx = px;
  float alpha = aShape.z * uColor.a * uWorldColorAlpha.a;
  vFill = vec4(aFill.rgb * aFill.a, aFill.a) * alpha;
  vStroke = vec4(aStroke.rgb * aStroke.a, aStroke.a) * alpha;
}
`;

const FRAGMENT = `#version 300 es
in vec2 vLocal;
in vec4 vRect;
in vec2 vShape;
in vec4 vFill;
in vec4 vStroke;
in float vPx;

out vec4 finalColor;

void main() {
  vec2 half_ = vRect.zw * 0.5;
  float r = min(vShape.x, min(half_.x, half_.y));
  vec2 q = abs(vLocal - vRect.xy - half_) - half_ + r;
  // Signed distance to the rounded rectangle's edge: negative inside.
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float fill = clamp(0.5 - d / vPx, 0.0, 1.0);
  float stroke = vShape.y > 0.0 ? clamp(0.5 - (abs(d) - vShape.y * 0.5) / vPx, 0.0, 1.0) : 0.0;
  vec4 s = vStroke * stroke;
  finalColor = s + vFill * fill * (1.0 - s.a);
}
`;

let shader: Shader | null = null;
function cellShader(): Shader {
  shader ??= new Shader({
    glProgram: GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: "pr0l1ne-cells" }),
    resources: {},
  });
  return shader;
}

/** RGBA8 as one little-endian 32-bit word, as unorm8x4 reads it: r in the low byte. */
const pack = (color: number, alpha: number) =>
  (((color >> 16) & 255) | (color & 0xff00) | ((color & 255) << 16) | (Math.round(alpha * 255) << 24)) >>> 0;

/** The cells' geometry: a unit quad, and an instance per cell. Its bounds are the cells'. */
class CellGeometry extends Geometry {
  private readonly area: Bounds;
  constructor(
    readonly data: Float32Array,
    count: number,
    area: Rectangle,
  ) {
    const instances = new Buffer({ data, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    const bytes = STRIDE * 4;
    super({
      attributes: {
        aPosition: { buffer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), format: "float32x2" },
        aRect: { buffer: instances, format: "float32x4", stride: bytes, offset: 0, instance: true },
        aShape: { buffer: instances, format: "float32x3", stride: bytes, offset: 16, instance: true },
        aFill: { buffer: instances, format: "unorm8x4", stride: bytes, offset: 28, instance: true },
        aStroke: { buffer: instances, format: "unorm8x4", stride: bytes, offset: 32, instance: true },
      },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
      instanceCount: count,
    });
    this.area = new Bounds(area.x, area.y, area.right, area.bottom);
  }
  /** Not the unit quad's: the cells'. */
  override get bounds(): Bounds {
    return this.area;
  }
}

/** One draw of many cells, following each cell's layer (CellBatch in pixiScene.ts). */
class CellMesh extends Mesh<CellGeometry, Shader> implements CellBatch {
  private readonly at: Float32Array;
  constructor(
    private readonly cells: CellRect[],
    private readonly layers: Container[],
  ) {
    const data = new Float32Array(cells.length * STRIDE);
    const words = new Uint32Array(data.buffer);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    cells.forEach((c, i) => {
      const o = i * STRIDE;
      const sw = c.stroke?.width ?? 0;
      data[o] = c.x;
      data[o + 1] = c.y;
      data[o + 2] = c.w;
      data[o + 3] = c.h;
      data[o + 4] = c.r;
      data[o + 5] = sw;
      data[o + 6] = 1;
      words[o + 7] = c.fill ? pack(c.fill.color, c.fill.alpha) : 0;
      words[o + 8] = c.stroke ? pack(c.stroke.color, c.stroke.alpha) : 0;
      minX = Math.min(minX, c.x - sw / 2);
      minY = Math.min(minY, c.y - sw / 2);
      maxX = Math.max(maxX, c.x + c.w + sw / 2);
      maxY = Math.max(maxY, c.y + c.h + sw / 2);
    });
    const area = new Rectangle(minX, minY, maxX - minX, maxY - minY);
    super({ geometry: new CellGeometry(data, cells.length, area), shader: cellShader() });
    // Where each cell's layer was when last read (x, y, opacity): what's in the instances now.
    this.at = new Float32Array(cells.length * 3);
    for (let i = 0; i < cells.length; i++) this.at[i * 3 + 2] = 1;
    this.boundsArea = area;
  }

  sync(): void {
    const data = this.geometry.data;
    const at = this.at;
    let changed = false;
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      const alpha = layer.visible ? layer.alpha : 0;
      const k = i * 3;
      if (layer.x === at[k] && layer.y === at[k + 1] && alpha === at[k + 2]) continue;
      at[k] = layer.x;
      at[k + 1] = layer.y;
      at[k + 2] = alpha;
      const o = i * STRIDE;
      data[o] = this.cells[i].x + layer.x;
      data[o + 1] = this.cells[i].y + layer.y;
      data[o + 6] = alpha;
      changed = true;
    }
    if (changed) this.geometry.attributes.aRect.buffer.update();
  }

  override destroy(options?: Parameters<Mesh["destroy"]>[0]): void {
    const geometry = this.geometry;
    super.destroy(options);
    geometry.destroy(true);
  }
}

/** Make the one draw of a body's cells (BuildOptions.cells). */
export function cellMesh(cells: CellRect[], layers: Container[]): CellBatch & Container {
  return new CellMesh(cells, layers);
}
