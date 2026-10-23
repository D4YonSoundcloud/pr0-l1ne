/**
 * Drawing a SQL trace's scenes (scene/sqlScene.ts) as marks (drawing.ts),
 * which either renderer draws, as for every scene.
 *
 *   sqlTableDrawing      the memory window: the stage's clause and what it
 *                        did, then its tables, row by row
 *   sqlPipelineDrawing   the loop window: the statement's stages, top to
 *                        bottom, the current one marked
 *
 * Every row is its own group, keyed by its id (data-flip), and rows keep
 * their ids from step to step: when ORDER BY moves a row, or WHERE drops
 * the rows around it, the animation slides it from where it was.
 */
import type { SqlPipelineScene, SqlTableScene } from "../scene/sqlScene";
import type { SqlColumn, SqlRow, SqlTable } from "../trace/types";
import { s, textWidth, uiTextWidth } from "./draw";
import type { Mark } from "./drawing";

const MARGIN = 24;
const TITLE_H = 26;
const HEAD_H = 28;
const ROW_H = 28;
const LABEL_W = 46;
const PAD = 10;
const MIN_CELL_W = 46;
const MAX_CELL_W = 240;
const TABLE_GAP = 44;
const NOTE_GAP = 12;
/** Value text size, as in .sql-svg (styles.css). */
const VALUE_SIZE = 13;
const NOTE_SIZE = 11.5;

// ---------------------------------------------------------------- the table window

/** A value as drawn: its text and how it's styled. */
function cellText(value: string | null, column: SqlColumn): { text: string; cls: string } {
  if (column.role === "check" || column.role === "result") {
    if (value === "true") return { text: "true", cls: "value v-bool sql-true" };
    if (value === "false") return { text: "false", cls: "value v-bool sql-false" };
    return { text: "NULL", cls: "value v-none sql-unknown" };
  }
  if (column.role === "inputs") return { text: value ?? "", cls: "value sql-inputs" };
  if (value === null) return { text: "NULL", cls: "value v-none" };
  if (column.type === "boolean")
    return { text: value === "t" ? "true" : value === "f" ? "false" : value, cls: "value v-bool" };
  return { text: value, cls: column.numeric ? "value v-num" : "value v-str" };
}

/** Text cut to a width, with an ellipsis. */
function clip(text: string, width: number, size = VALUE_SIZE): string {
  const max = Math.max(1, Math.floor(width / (size * 0.6)));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Text in the UI font cut to a width, with an ellipsis. */
function clipUi(text: string, width: number, size: number): string {
  const max = Math.max(1, Math.floor(width / (size * 0.56)));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A column's heading: its name (or, for an expression Postgres didn't name, the expression). */
function heading(column: SqlColumn, sortKeys: number): string {
  const name = column.role === "computed" && column.name === "?column?" && column.expr ? column.expr : column.name;
  if (!column.sort) return name;
  return `${name} ${column.sort.desc ? "▼" : "▲"}${sortKeys > 1 ? column.sort.rank : ""}`;
}

interface Measured {
  table: SqlTable;
  widths: number[];
  /** Width of the table box, and of the notes beside it. */
  w: number;
  notesW: number;
  h: number;
}

function measure(table: SqlTable): Measured {
  const sortKeys = table.columns.filter((c) => c.sort).length;
  const widths = table.columns.map((column, i) => {
    const values = table.rows.map((r) => textWidth(cellText(r.values[i] ?? null, column).text, VALUE_SIZE));
    const head = textWidth(heading(column, sortKeys), 12);
    return Math.min(MAX_CELL_W, Math.max(MIN_CELL_W, head + 2 * PAD, ...values.map((v) => v + 2 * PAD)));
  });
  const titleW =
    uiTextWidth(`${table.name}${table.alias ? ` AS ${table.alias}` : ""}`, 13) + uiTextWidth("000 rows", 11.5) + 48;
  const w = Math.max(LABEL_W + widths.reduce((a, b) => a + b, 0), titleW);
  const notes = table.rows.map((r) => (r.note && !table.cuts?.length ? uiTextWidth(r.note, NOTE_SIZE) : 0));
  // (A join's two tables draw no notes: see joinTables.)
  const cutNotes = [
    ...(table.cuts ?? []).map((c) => uiTextWidth(c.label, NOTE_SIZE)),
    ...(table.groups ?? []).map((g) => uiTextWidth(groupText(g), NOTE_SIZE)),
  ];
  const notesW = Math.max(0, ...notes, ...cutNotes);
  const h = TITLE_H + HEAD_H + table.rows.length * ROW_H + (table.more ? ROW_H : 0) + 6;
  return { table, widths, w, notesW: notesW ? notesW + NOTE_GAP : 0, h };
}

const rowsText = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;

/** A group's label beside its first row: "G2 · category = Coffee · 3 rows". */
const groupText = (g: NonNullable<SqlTable["groups"]>[number], i = -1) =>
  `${i >= 0 ? `G${i + 1} · ` : "G00 · "}${g.label} · ${rowsText(g.count)}`;

/** Group colors cycle through this many (styles.css, .in-group-N). */
const GROUP_COLORS = 6;

/**
 * A table at (x, y), and the middle of each row drawn (for a join's lines).
 * The table itself isn't animated, its rows are: moving both, a row would
 * move twice.
 */
function drawTable(m: Measured, x: number, y: number, withNotes = true): { g: Mark; rowMid: Map<string, number> } {
  const { table, widths, w } = m;
  const sortKeys = table.columns.filter((c) => c.sort).length;
  const g = s("g", { class: "sql-table" });
  const rowMid = new Map<string, number>();
  const bodyH = m.h;
  g.append(
    s("rect", { class: "box-body sql-table-body", x, y, width: w, height: bodyH, rx: 5 }),
    s("path", {
      class: "box-header",
      d: `M${x},${y + TITLE_H} V${y + 5} q0,-5 5,-5 H${x + w - 5} q5,0 5,5 V${y + TITLE_H} z`,
    }),
    s(
      "text",
      { class: "box-title", x: x + 10, y: y + TITLE_H / 2, "dominant-baseline": "central" },
      `${table.name}${table.alias ? ` AS ${table.alias}` : ""}`,
    ),
  );
  const shown = table.rows.filter((r) => r.status !== "removed").length;
  const total = table.rows.length + (table.more ?? 0);
  g.append(
    s(
      "text",
      { class: "box-size", x: x + w - 9, y: y + TITLE_H / 2, "text-anchor": "end", "dominant-baseline": "central" },
      shown === table.rows.length ? rowsText(total) : `${shown} of ${rowsText(total)}`,
    ),
  );

  // Column headings, and where each column starts.
  const lefts: number[] = [];
  let cx = x + LABEL_W;
  const headY = y + TITLE_H;
  g.append(s("rect", { class: "sql-head-bg", x: x + 1, y: headY, width: w - 2, height: HEAD_H }));
  table.columns.forEach((column, i) => {
    lefts.push(cx);
    const role = column.role ? ` is-${column.role}` : "";
    const sorted = column.sort ? " is-sorted" : "";
    if (column.role === "computed" || column.role === "sort" || column.role === "key" || column.role === "problem") {
      g.append(
        s("rect", { class: `sql-col-bg${role}`, x: cx, y: headY, width: widths[i], height: bodyH - TITLE_H - 6 }),
      );
    }
    const head = s(
      "text",
      {
        class: `sql-head${role}${sorted}`,
        x: column.numeric ? cx + widths[i] - PAD : cx + PAD,
        y: headY + HEAD_H / 2,
        "text-anchor": column.numeric ? "end" : "start",
        "dominant-baseline": "central",
      },
      clip(heading(column, sortKeys), widths[i] - 2 * PAD, 12),
    );
    head.append(s("title", {}, `${column.expr ?? column.name} (${column.type})`));
    g.append(head);
    // A line before the condition's columns: they aren't the table's.
    if ((column.role === "check" || column.role === "result") && table.columns[i - 1]?.role === undefined) {
      g.append(s("line", { class: "sql-divider", x1: cx, y1: headY + 4, x2: cx, y2: y + bodyH - 6 }));
    }
    cx += widths[i];
  });
  g.append(s("line", { class: "sql-head-line", x1: x, y1: headY + HEAD_H, x2: x + w, y2: headY + HEAD_H }));

  // The rows.
  const rowsY = headY + HEAD_H;
  // With cut lines, they say why rows go (and notes beside the rows would crowd their labels).
  const notes = withNotes && !table.cuts?.length;
  table.rows.forEach((row, r) => {
    g.append(drawRow(row, table.columns, widths, lefts, x, rowsY + r * ROW_H, w, r, notes));
    rowMid.set(row.id, rowsY + r * ROW_H + ROW_H / 2);
  });
  if (table.more) {
    g.append(
      s(
        "text",
        {
          class: "box-empty",
          x: x + 10,
          y: rowsY + table.rows.length * ROW_H + ROW_H / 2,
          "dominant-baseline": "central",
        },
        `… ${rowsText(table.more)} more, not drawn`,
      ),
    );
  }
  // GROUP BY's groups: a line between them, and what each one's rows share.
  for (const [i, group] of (table.groups ?? []).entries()) {
    const gy = rowsY + group.start * ROW_H;
    if (i > 0) g.append(s("line", { class: "sql-group-line", x1: x, y1: gy, x2: x + w, y2: gy }));
    if (!group.count) continue;
    g.append(
      s(
        "text",
        {
          class: `sql-group-label in-group-${i % GROUP_COLORS}`,
          x: x + w + NOTE_GAP,
          y: gy + ROW_H / 2,
          "dominant-baseline": "central",
        },
        groupText(group, i),
      ),
    );
  }
  // LIMIT and OFFSET's cuts.
  for (const cut of table.cuts ?? []) {
    const cy = rowsY + cut.before * ROW_H;
    g.append(
      s(
        "g",
        { class: "sql-cut", "data-flip": `sqlcut:${table.name}:${cut.label}`, "data-x": x, "data-y": cy },
        s("line", { x1: x - 6, y1: cy, x2: x + w + 6, y2: cy }),
        s("text", { x: x + w + NOTE_GAP, y: cy, "dominant-baseline": "central" }, cut.label),
      ),
    );
  }
  return { g, rowMid };
}

function drawRow(
  row: SqlRow,
  columns: SqlColumn[],
  widths: number[],
  lefts: number[],
  x: number,
  y: number,
  w: number,
  index: number,
  withNote: boolean,
): Mark {
  const cls = [
    "sql-row",
    index % 2 ? "is-odd" : "",
    row.status ? `is-${row.status}` : "",
    row.tie ? "is-tie" : "",
    row.group !== undefined ? `in-group-${row.group % GROUP_COLORS}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const g = s("g", { class: cls, "data-flip": `sqlrow:${row.id}`, "data-x": x, "data-y": y });
  g.append(s("rect", { class: "sql-row-bg", x: x + 1, y, width: w - 2, height: ROW_H }));
  // A group's color, down the left edge of its rows.
  if (row.group !== undefined)
    g.append(s("rect", { class: "sql-group-mark", x: x + 1, y: y + 2, width: 4, height: ROW_H - 4 }));
  const mid = y + ROW_H / 2;
  g.append(
    s(
      "text",
      { class: "sql-label", x: x + 10, y: mid, "dominant-baseline": "central" },
      `${row.tie ? "= " : ""}${row.label}`,
    ),
  );
  columns.forEach((column, i) => {
    const { text, cls: valueCls } = cellText(row.values[i] ?? null, column);
    g.append(
      s(
        "text",
        {
          class: valueCls,
          x: column.numeric ? lefts[i] + widths[i] - PAD : lefts[i] + PAD,
          y: mid,
          "text-anchor": column.numeric ? "end" : "start",
          "dominant-baseline": "central",
        },
        clip(text, widths[i] - 2 * PAD),
      ),
    );
  });
  if (row.status === "removed") {
    g.append(s("line", { class: "sql-strike", x1: x + 6, y1: mid, x2: x + w - 6, y2: mid }));
  }
  if (row.note && withNote) {
    g.append(
      s("text", { class: "sql-row-note", x: x + w + NOTE_GAP, y: mid, "dominant-baseline": "central" }, row.note),
    );
  }
  return g;
}

/** The memory window for a SQL step: the clause, what it did, and the tables. */
export function sqlTableDrawing(scene: SqlTableScene): Mark {
  const { stage } = scene;
  const svg = s("svg", { class: "memory-svg sql-svg", xmlns: "http://www.w3.org/2000/svg" });
  const caption = s("g", { class: "sql-caption" });
  let y = MARGIN + 8;
  caption.append(s("text", { class: "sql-clause", x: MARGIN, y, "dominant-baseline": "central" }, stage.clause));
  y += 22;
  caption.append(s("text", { class: "sql-summary", x: MARGIN, y, "dominant-baseline": "central" }, stage.summary));
  let maxX = MARGIN + Math.max(textWidth(stage.clause, 14), uiTextWidth(stage.summary, 12.5));
  for (const note of stage.notes ?? []) {
    y += 20;
    caption.append(s("text", { class: "sql-stage-note", x: MARGIN, y, "dominant-baseline": "central" }, note));
    maxX = Math.max(maxX, MARGIN + uiTextWidth(note, 12));
  }
  svg.append(caption);

  const top = y + 26;
  let x = MARGIN;
  let bottom = top;
  const tables = s("g", { class: "sql-tables" });
  if (stage.kind === "join" && stage.tables.length === 3) {
    const placed = joinTables(stage, top, tables);
    x = placed.right + TABLE_GAP;
    bottom = placed.bottom;
  } else {
    for (const table of stage.tables) {
      const m = measure(table);
      tables.append(drawTable(m, x, top).g);
      x += m.w + m.notesW + TABLE_GAP;
      bottom = Math.max(bottom, top + m.h);
    }
  }
  if (!stage.tables.length) {
    tables.append(
      s(
        "text",
        { class: "sql-stage-note", x: MARGIN, y: top + 8, "dominant-baseline": "central" },
        "No table to show.",
      ),
    );
    bottom = top + 16;
  }
  svg.append(tables);
  const width = Math.max(maxX, x - TABLE_GAP) + MARGIN;
  const height = bottom + MARGIN;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return svg;
}

/** Room between a join's two tables, for the lines between their rows; and before the rows it makes. */
const JOIN_GAP = 96;
const JOIN_RESULT_GAP = 64;

/**
 * A join: the rows so far and the table joined side by side, a line from
 * each row to each row it pairs with, then the rows the join makes.
 */
function joinTables(stage: SqlTableScene["stage"], top: number, layer: Mark): { right: number; bottom: number } {
  const [soFar, joined, made] = stage.tables.map(measure);
  const left = drawTable(soFar, MARGIN, top, false);
  const rightX = MARGIN + soFar.w + JOIN_GAP;
  const right = drawTable(joined, rightX, top, false);
  const lines = s("g", { class: "sql-links" });
  for (const link of stage.links ?? []) {
    const y1 = left.rowMid.get(link.from);
    const y2 = right.rowMid.get(link.to);
    if (y1 === undefined || y2 === undefined) continue;
    const x1 = MARGIN + soFar.w;
    const x2 = rightX;
    const bend = JOIN_GAP * 0.45;
    lines.append(
      s("path", { class: "sql-link", d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}` }),
    );
  }
  layer.append(left.g, right.g, lines);
  // The rows it makes: to the right, or below, whichever fits a window
  // about twice as wide as it's tall at the larger size.
  const pairW = rightX + joined.w - MARGIN;
  const pairH = Math.max(soFar.h, joined.h);
  const across = { w: pairW + JOIN_RESULT_GAP + made.w + made.notesW, h: Math.max(pairH, made.h) };
  const down = { w: Math.max(pairW, made.w + made.notesW), h: pairH + 44 + made.h };
  const scale = (size: { w: number; h: number }) => Math.min(2 / size.w, 1 / size.h);
  if (scale(across) >= scale(down)) {
    const resultX = rightX + joined.w + JOIN_RESULT_GAP;
    const mid = top + Math.min(pairH, made.h) / 2;
    layer.append(
      s("path", {
        class: "sql-stage-arrow",
        d: `M${rightX + joined.w + 12},${mid} H${resultX - 12} m-6,-5 l6,5 l-6,5`,
      }),
    );
    layer.append(drawTable(made, resultX, top).g);
    return { right: MARGIN + across.w, bottom: top + across.h };
  }
  const resultTop = top + pairH + 44;
  layer.append(
    s(
      "text",
      { class: "sql-stage-note", x: MARGIN, y: resultTop - 14, "dominant-baseline": "central" },
      "The rows it makes:",
    ),
  );
  layer.append(drawTable(made, MARGIN, resultTop).g);
  return { right: MARGIN + down.w, bottom: top + down.h };
}

// ---------------------------------------------------------------- the pipeline window

const CARD_H = 50;
const CARD_GAP = 22;
const CHIP_W = 92;

/** The keyword a stage's chip shows. */
function chip(scene: SqlPipelineScene, kind: string, clause: string): string {
  switch (kind) {
    case "tables":
      return "DATABASE";
    case "from":
      return "FROM";
    case "where":
      return "WHERE";
    case "select":
      return "SELECT";
    case "distinct":
      return "DISTINCT";
    case "order":
      return "ORDER BY";
    case "limit":
      return "LIMIT";
    case "result":
      return "RESULT";
    case "group":
      return "GROUP BY";
    case "aggregate":
      return "AGGREGATE";
    case "having":
      return "HAVING";
    case "join":
      return /^(?:NATURAL )?((?:LEFT |RIGHT |FULL |CROSS )?JOIN)/.exec(clause)?.[1] ?? "JOIN";
    default:
      return scene.statement.kind.split(" ")[0];
  }
}

/** The loop window for a SQL step: the statement's stages, in the order they run. */
export function sqlPipelineDrawing(scene: SqlPipelineScene): Mark {
  const svg = s("svg", { class: "loop-svg sql-svg sql-pipeline", xmlns: "http://www.w3.org/2000/svg" });
  let y = MARGIN + 6;
  const head =
    scene.statement.kind === "DATABASE" ? "The sample database" : `Statement ${scene.number} of ${scene.count}`;
  svg.append(s("text", { class: "sql-pipeline-title", x: MARGIN, y, "dominant-baseline": "central" }, head));
  y += 20;
  svg.append(
    s("text", { class: "sql-pipeline-code", x: MARGIN, y, "dominant-baseline": "central" }, scene.statement.text),
  );
  let width = Math.max(uiTextWidth(head, 12), textWidth(scene.statement.text, 12.5));
  y += 26;

  const texts = scene.stages.map(({ stage }) => ({
    clause: stage.clause,
    summary: stage.summary,
    rows: stage.rows === undefined ? "" : rowsText(stage.rows),
  }));
  const textW = Math.max(200, ...texts.map((t) => Math.max(textWidth(t.clause, 12.5), uiTextWidth(t.summary, 12))));
  const rowsW = Math.max(0, ...texts.map((t) => uiTextWidth(t.rows, 12)));
  const cardW = CHIP_W + 14 + Math.min(textW, 600) + 16 + rowsW + 14;
  width = Math.max(width, cardW);

  scene.stages.forEach(({ stage, state }, i) => {
    const t = texts[i];
    const top = y;
    const g = s("g", {
      class: `sql-stage loop-row is-${state}`,
      "data-top": top,
      "data-bottom": top + CARD_H,
    });
    g.append(s("rect", { class: "sql-stage-card", x: MARGIN, y: top, width: cardW, height: CARD_H, rx: 6 }));
    g.append(s("rect", { class: "sql-stage-chip", x: MARGIN + 8, y: top + 13, width: CHIP_W - 8, height: 24, rx: 4 }));
    g.append(
      s(
        "text",
        {
          class: "sql-stage-keyword",
          x: MARGIN + 8 + (CHIP_W - 8) / 2,
          y: top + 25,
          "text-anchor": "middle",
          "dominant-baseline": "central",
        },
        chip(scene, stage.kind, stage.clause),
      ),
    );
    const tx = MARGIN + CHIP_W + 14;
    const room = Math.min(textW, 600);
    g.append(
      s(
        "text",
        { class: "sql-stage-clause", x: tx, y: top + 17, "dominant-baseline": "central" },
        clip(t.clause, room, 12.5),
      ),
    );
    g.append(
      s(
        "text",
        { class: "sql-stage-summary", x: tx, y: top + 35, "dominant-baseline": "central" },
        clipUi(t.summary, room, 12),
      ),
    );
    if (t.rows) {
      g.append(
        s(
          "text",
          {
            class: "sql-stage-rows",
            x: MARGIN + cardW - 14,
            y: top + CARD_H / 2,
            "text-anchor": "end",
            "dominant-baseline": "central",
          },
          t.rows,
        ),
      );
    }
    svg.append(g);
    y += CARD_H;
    if (i < scene.stages.length - 1) {
      const ax = MARGIN + 8 + (CHIP_W - 8) / 2;
      svg.append(s("path", { class: "sql-stage-arrow", d: `M${ax},${y + 3} V${y + CARD_GAP - 5} m-4,-5 l4,5 l4,-5` }));
      y += CARD_GAP;
    }
  });
  for (const note of scene.stages.flatMap(({ stage }) => (stage.kind === "result" ? (stage.notes ?? []) : []))) {
    y += 22;
    svg.append(s("text", { class: "sql-stage-note", x: MARGIN, y, "dominant-baseline": "central" }, note));
    width = Math.max(width, uiTextWidth(note, 12));
  }
  const w = width + 2 * MARGIN;
  const h = y + MARGIN;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  return svg;
}
