/** The loop view's bands between rows: a loop's header, unrecorded passes, passes where nothing changed. */
import { evaluatedHeader, type LoopItem, type LoopScene } from "../../scene/loopScene";
import { s, uiTextWidth } from "../draw";
import type { Mark } from "../drawing";
import type { LoopPlan } from "./plan";
import { BAND_H, INDENT, MARGIN } from "./shared";

type Item<K extends LoopItem["kind"]> = Extract<LoopItem, { kind: K }>;

/** A loop's header ("for i in range(n)"), and with every loop together, its values as this run started. */
export function drawHeader(layer: Mark, item: Item<"header">, y: number, plan: LoopPlan, scene: LoopScene): number {
  const { scalarsX } = plan;
  const info = scene.info(item.loop);
  if (!info) return 0;
  const g = s("g", { class: "loop-header" });
  g.append(
    s("line", {
      class: "loop-header-rule",
      x1: MARGIN + item.depth * INDENT,
      x2: scalarsX - 10,
      y1: y + BAND_H / 2,
      y2: y + BAND_H / 2,
    }),
  );
  const text = s(
    "text",
    { x: scalarsX, y: y + BAND_H / 2, "dominant-baseline": "central" },
    s("tspan", { class: "loop-header-code" }, info.header),
  );
  if (item.call) {
    text.append(
      s("tspan", { class: "loop-header-arrow", dx: 10 }, "→"),
      s("tspan", { class: "loop-header-call", dx: 10 }, evaluatedHeader(info, item.call)),
    );
    g.append(s("title", {}, `This run of the loop on line ${info.line}, with its values as it started`));
  }
  g.append(text);
  layer.append(g);
  y += BAND_H;
  return BAND_H;
}

/** Passes of a sampled loop that ran but weren't recorded. */
export function drawGap(layer: Mark, item: Item<"gap">, y: number, plan: LoopPlan): number {
  const { contentW } = plan;
  const count = item.to - item.from + 1;
  const n = item.name ? `${item.name} ` : "";
  const text =
    count === 1
      ? `${n}#${item.from}: 1 pass ran, not recorded`
      : `${n}#${item.from} to #${item.to}: ${count.toLocaleString()} passes like these ran, not recorded`;
  const textX = MARGIN + plan.gutter;
  layer.append(
    s(
      "g",
      { class: "quiet-band sampled-band" },
      s(
        "title",
        {},
        "A long loop is sampled: its first passes, passes at round numbers and its last passes are recorded. The passes in between ran, and are counted, but weren't recorded.",
      ),
      s("line", { x1: MARGIN, x2: contentW, y1: y + BAND_H / 2, y2: y + BAND_H / 2 }),
      s("rect", { x: textX - 8, y: y + 4, width: uiTextWidth(text, 12.5) + 16, height: BAND_H - 8, rx: 4 }),
      s("text", { x: textX, y: y + BAND_H / 2, "dominant-baseline": "central" }, text),
    ),
  );
  return BAND_H + 6;
}

/** Passes where nothing that's shown changed, as one band. */
export function drawQuietBand(layer: Mark, item: Item<"band">, y: number, plan: LoopPlan): number {
  const { contentW } = plan;
  const n = item.name ? `${item.name} ` : "";
  const text =
    item.from === item.to ? `${n}#${item.from}: nothing changed` : `${n}#${item.from} to #${item.to}: nothing changed`;
  const textX = MARGIN + plan.gutter;
  layer.append(
    s(
      "g",
      { class: "quiet-band" },
      s("line", { x1: MARGIN, x2: contentW, y1: y + BAND_H / 2, y2: y + BAND_H / 2 }),
      s("rect", { x: textX - 8, y: y + 4, width: uiTextWidth(text, 12.5) + 16, height: BAND_H - 8, rx: 4 }),
      s("text", { x: textX, y: y + BAND_H / 2, "dominant-baseline": "central" }, text),
    ),
  );
  return BAND_H + 6;
}
