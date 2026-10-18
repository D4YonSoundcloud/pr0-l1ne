/**
 * Save a window's drawing as a standalone SVG file.
 *
 * On screen, the drawing is styled by the app's CSS (styles.css and the
 * Style panel's variables). A file opened elsewhere (a browser, Inkscape,
 * Figma, Illustrator) has none of that, so each element gets its computed
 * style written onto it: colors as hex with an opacity, line widths, dashes,
 * fonts. Both renderers export the same file, from the same SVG layout;
 * styles come from the canvas renderer's style probe (canvas/styles.ts),
 * which reads them with animations stopped, so a flash mid-way through
 * never ends up in the file.
 */
import { parseColor } from "./canvas/color";
import type { ComputedPaint, StyleSource } from "./canvas/styles";

const NS = "http://www.w3.org/2000/svg";

const SHAPES = new Set(["rect", "circle", "ellipse", "line", "path", "polyline", "polygon"]);
const TEXT = new Set(["text", "tspan"]);

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** A paint (fill or stroke) as SVG properties that every viewer understands. */
function paint(name: "fill" | "stroke", css: string, opacity: number): string[] {
  const color = parseColor(css);
  if (!color) return [`${name}:none`];
  const out = [`${name}:${hex(color.rgb)}`];
  const alpha = round(color.alpha * opacity);
  if (alpha < 1) out.push(`${name}-opacity:${alpha}`);
  return out;
}

/** The style attribute for one element, from its computed paint. */
export function styleFor(tag: string, s: ComputedPaint): string {
  const out: string[] = [];
  if (s.hidden) return "display:none";
  if (s.opacity < 1) out.push(`opacity:${round(s.opacity)}`);
  const isShape = SHAPES.has(tag);
  const isText = TEXT.has(tag);
  if (isShape || isText) {
    out.push(...paint("fill", s.fill, s.fillOpacity));
    out.push(...paint("stroke", s.stroke, s.strokeOpacity));
    if (parseColor(s.stroke)) {
      out.push(`stroke-width:${round(s.strokeWidth)}`);
      if (s.dash.length) out.push(`stroke-dasharray:${s.dash.map(round).join(" ")}`);
      if (s.dashOffset) out.push(`stroke-dashoffset:${round(s.dashOffset)}`);
      if (s.cap !== "butt") out.push(`stroke-linecap:${s.cap}`);
      if (s.join !== "miter") out.push(`stroke-linejoin:${s.join}`);
    }
  }
  if (tag === "rect" && s.rx !== null) out.push(`rx:${round(s.rx)}px`);
  if (isText) {
    out.push(`font-family:${s.fontFamily}`, `font-size:${round(s.fontSize)}px`);
    if (s.fontWeight !== "400" && s.fontWeight !== "normal") out.push(`font-weight:${s.fontWeight}`);
    if (s.fontStyle !== "normal") out.push(`font-style:${s.fontStyle}`);
    if (s.letterSpacing) out.push(`letter-spacing:${round(s.letterSpacing)}px`);
    if (s.whiteSpace.startsWith("pre")) out.push("white-space:pre");
    if (s.paintOrder !== "normal") out.push(`paint-order:${s.paintOrder}`);
  }
  return out.join(";");
}

/**
 * A drawing as a standalone SVG document: its computed styles inlined, and
 * the window's paper color behind it.
 */
export function standaloneSvg(svg: SVGSVGElement, styles: StyleSource, background = ""): string {
  const computed = styles.read(svg);
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  from.forEach((el, i) => {
    const s = computed.get(el);
    const target = to[i];
    // The data-* attributes are for the app's animation and dragging; a file doesn't need them.
    for (const name of target.getAttributeNames()) if (name.startsWith("data-")) target.removeAttribute(name);
    if (!s || el === svg) return;
    const style = styleFor(el.localName, s);
    if (style) target.setAttribute("style", style);
  });
  // XMLSerializer writes the SVG namespace itself; an xmlns attribute as well would make it twice.
  copy.removeAttribute("xmlns");
  copy.removeAttribute("aria-hidden");
  const width = copy.getAttribute("width");
  const height = copy.getAttribute("height");
  if (width && height && !copy.hasAttribute("viewBox")) copy.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const paper = parseColor(background);
  if (paper) {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("width", "100%");
    rect.setAttribute("height", "100%");
    rect.setAttribute("style", paint("fill", background, 1).join(";"));
    const defs = copy.querySelector(":scope > defs");
    if (defs) defs.after(rect);
    else copy.prepend(rect);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}\n`;
}

/** Hand the person a file to save. */
export function download(name: string, text: string, type = "image/svg+xml"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
