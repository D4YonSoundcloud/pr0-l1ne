// @vitest-environment jsdom
/**
 * The SQL drawings (sqlView.ts), at every step of every SQL example: each
 * row drawn once, keyed by its id so it can be followed between steps; the
 * pipeline marks the step's stage; and patching the SVG from step to step
 * leaves what a fresh drawing makes.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { SQL_EXAMPLES } from "../examples/index";
import { sqlPipelineScene, sqlTableScene } from "../scene/sqlScene";
import { PgliteEngine } from "../sql/engine";
import { loadParser } from "../sql/parser";
import { traceSql } from "../sql/trace";
import type { Trace } from "../trace/types";
import { type Mark, toSvg } from "./drawing";
import { SvgPatcher } from "./patch";
import { sqlPipelineDrawing, sqlTableDrawing } from "./sqlView";

let engine: PgliteEngine;
beforeAll(async () => {
  engine = await PgliteEngine.create();
}, 60_000);

const traceOf = async (code: string): Promise<Trace> => traceSql(code, engine, await loadParser());
/** Elements of a drawing, made into SVG (marks only take simple selectors). */
const all = (root: Mark, selector: string) => [...toSvg(root).querySelectorAll(selector)];

describe("SQL drawings of the examples", () => {
  it.each(SQL_EXAMPLES.map((e) => [e.name, e.code] as const))("%s", async (_name, code) => {
    const trace = await traceOf(code);
    const tables = new SvgPatcher();
    const pipeline = new SvgPatcher();
    trace.steps.forEach((_step, i) => {
      const stage = trace.sql!.stages[i];
      const drawing = sqlTableDrawing(sqlTableScene(trace, i)!);
      // Each row once, keyed by its id, one below another.
      const rows = all(drawing, ".sql-row");
      // (An aggregate's step draws the groups' rows too, beside the rows they become.)
      const fold = sqlTableScene(trace, i)!.fold;
      const expected = stage.tables.reduce((n, t) => n + t.rows.length, 0) + (fold?.rows.length ?? 0);
      expect(rows).toHaveLength(expected);
      const keys = rows.map((r) => r.getAttribute("data-flip"));
      expect(new Set(keys).size).toBe(keys.length);
      // Removed rows are struck through; the rest aren't.
      for (const row of rows) {
        expect(row.querySelector(".sql-strike") !== null).toBe(row.getAttribute("class")?.includes("is-removed"));
      }
      expect(Number(drawing.getAttribute("width"))).toBeGreaterThan(100);
      expect(tables.show(drawing).outerHTML, `tables, step ${i + 1}`).toBe(toSvg(drawing).outerHTML);

      const steps = sqlPipelineDrawing(sqlPipelineScene(trace, i)!);
      const cards = all(steps, ".sql-stage");
      expect(cards.length).toBe(trace.sql!.stages.filter((s) => s.statement === stage.statement).length);
      expect(all(steps, ".sql-stage.is-current")).toHaveLength(1);
      expect(pipeline.show(steps).outerHTML, `pipeline, step ${i + 1}`).toBe(toSvg(steps).outerHTML);
    });
  });
});

describe("the table drawing", () => {
  it("marks sort keys, computed columns and the condition's columns", async () => {
    const trace = await traceOf(
      "-- viz: database shop\nSELECT name, price * 2 AS twice FROM products WHERE price > 9 AND stock > 0 ORDER BY twice DESC, name;",
    );
    const at = (kind: string) => trace.sql!.stages.findIndex((s) => s.kind === kind);
    const where = sqlTableDrawing(sqlTableScene(trace, at("where"))!);
    expect(all(where, ".sql-head.is-check").map((h) => h.querySelector("title")?.textContent)).toEqual([
      "price > 9 (boolean)",
      "stock > 0 (boolean)",
    ]);
    expect(all(where, ".sql-divider")).toHaveLength(1);
    const order = sqlTableDrawing(sqlTableScene(trace, at("order"))!);
    const heads = all(order, ".sql-head").map((h) => h.firstChild?.textContent);
    expect(heads).toEqual(["name ▲2", "twice ▼1"]);
    expect(all(order, ".sql-head.is-computed")).toHaveLength(1);
  });

  it("draws LIMIT's and OFFSET's cuts, and NULL as NULL", async () => {
    const trace = await traceOf(
      "-- viz: database school\nSELECT name, gpa FROM students ORDER BY name LIMIT 3 OFFSET 2;",
    );
    const last = sqlTableDrawing(sqlTableScene(trace, trace.steps.length - 1)!);
    expect(all(last, ".sql-cut text").map((t) => t.textContent)).toEqual(["OFFSET 2", "LIMIT 3"]);
    const from = sqlTableDrawing(sqlTableScene(trace, 1)!);
    expect(all(from, ".value.v-none").map((t) => t.textContent)).toEqual(["NULL", "NULL"]);
  });

  it("shortens long values to fit their column", async () => {
    const trace = await traceOf(`SELECT repeat('x', 200) AS long;`);
    const drawing = sqlTableDrawing(sqlTableScene(trace, 0)!);
    const value = all(drawing, ".sql-row .value")[0].textContent ?? "";
    expect(value.length).toBeLessThan(40);
    expect(value.endsWith("…")).toBe(true);
  });
});

describe("the join drawing", () => {
  it("draws a line for each pair, and names the join in its chip", async () => {
    const trace = await traceOf(
      "-- viz: database shop\nSELECT c.name, o.id FROM customers AS c LEFT JOIN orders AS o ON o.customer_id = c.id;",
    );
    const at = trace.sql!.stages.findIndex((s) => s.kind === "join");
    const drawing = sqlTableDrawing(sqlTableScene(trace, at)!);
    expect(all(drawing, ".sql-link")).toHaveLength(14);
    expect(all(drawing, ".sql-table")).toHaveLength(3);
    expect(all(drawing, ".sql-row.is-unmatched").length).toBe(2); // Linus, and his row of NULLs
    const chips = all(sqlPipelineDrawing(sqlPipelineScene(trace, at)!), ".sql-stage-keyword").map((t) => t.textContent);
    expect(chips).toEqual(["FROM", "LEFT JOIN", "SELECT"]);
  });
});

describe("the group drawing", () => {
  it("colors each group, labels it, and draws a line between groups", async () => {
    const trace = await traceOf(
      "-- viz: database shop\nSELECT category, count(*) FROM products GROUP BY category HAVING count(*) > 2;",
    );
    const at = (kind: string) => trace.sql!.stages.findIndex((s) => s.kind === kind);
    const group = sqlTableDrawing(sqlTableScene(trace, at("group"))!);
    expect(all(group, ".sql-group-label").map((t) => t.textContent)).toEqual([
      "G1 · category = Tea · 4 rows",
      "G2 · category = Coffee · 3 rows",
      "G3 · category = Kitchen · 3 rows",
      "G4 · category = NULL · 2 rows",
    ]);
    expect(all(group, ".sql-group-line")).toHaveLength(3);
    expect(all(group, ".sql-row.in-group-0")).toHaveLength(4);
    expect(all(group, ".sql-group-mark")).toHaveLength(12);
    const having = sqlTableDrawing(sqlTableScene(trace, at("having"))!);
    expect(all(having, ".sql-row.is-removed")).toHaveLength(1);
    const chips = all(sqlPipelineDrawing(sqlPipelineScene(trace, at("having"))!), ".sql-stage-keyword").map(
      (t) => t.textContent,
    );
    expect(chips).toEqual(["FROM", "GROUP BY", "AGGREGATE", "HAVING", "SELECT"]);
  });
});

describe("parts of a statement", () => {
  it("are indented under their names in the pipeline, and named above their clause", async () => {
    const trace = await traceOf(
      "-- viz: database shop\nSELECT city FROM customers UNION SELECT category FROM products;",
    );
    const at = trace.sql!.stages.findIndex((s) => s.kind === "combine");
    const steps = sqlPipelineDrawing(sqlPipelineScene(trace, at)!);
    expect(all(steps, ".sql-part-label").map((t) => t.textContent)).toEqual([
      "UNION: the first query",
      "UNION: the second query",
    ]);
    const xs = all(steps, ".sql-stage-card").map((r) => Number(r.getAttribute("x")));
    expect(xs).toEqual([52, 52, 52, 52, 24]);
    const chips = all(steps, ".sql-stage-keyword").map((t) => t.textContent);
    expect(chips.at(-1)).toBe("UNION");
    // The combine step: both queries' rows, then the rows they make.
    const combine = sqlTableDrawing(sqlTableScene(trace, at)!);
    expect(all(combine, ".sql-table")).toHaveLength(3);
    const first = sqlTableDrawing(sqlTableScene(trace, 1)!);
    expect(all(first, ".sql-part-label")[0].textContent).toBe("UNION: the first query");
  });
});

describe("windows, passes and refusals", () => {
  it("name a window's partitions P1, P2, and chip each kind of step", async () => {
    const trace = await traceOf(`-- viz: database company
SELECT name, rank() OVER (PARTITION BY department_id ORDER BY salary) FROM employees;`);
    const at = trace.sql!.stages.findIndex((s) => s.kind === "window");
    const labels = all(sqlTableDrawing(sqlTableScene(trace, at)!), ".sql-group-label").map((t) => t.textContent);
    expect(labels[0]).toBe("P1 · department_id = 1 · 4 rows");
    const chips = all(sqlPipelineDrawing(sqlPipelineScene(trace, at)!), ".sql-stage-keyword").map((t) => t.textContent);
    expect(chips).toEqual(["FROM", "WINDOW", "SELECT"]);
  });

  it("chip a recursive query's passes, and a refused statement in red", async () => {
    const trace =
      await traceOf(`WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2) SELECT i FROM n;
CREATE TABLE t (id int PRIMARY KEY);
INSERT INTO t VALUES (1), (1);`);
    const chips = all(sqlPipelineDrawing(sqlPipelineScene(trace, 1)!), ".sql-stage-keyword").map((t) => t.textContent);
    expect(chips).toEqual(["SELECT", "PASS 1", "PASS 2", "ALL", "FROM", "SELECT"]);
    const last = trace.steps.length - 1;
    expect(all(sqlPipelineDrawing(sqlPipelineScene(trace, last)!), ".sql-stage-chip.is-refused")).toHaveLength(1);
  });
});

describe("the pipeline drawing", () => {
  it("numbers the statements, leaving out the sample database", async () => {
    const trace = await traceOf("-- viz: database shop\nSELECT 1;\nSELECT name FROM products;");
    const title = (i: number) =>
      all(sqlPipelineDrawing(sqlPipelineScene(trace, i)!), ".sql-pipeline-title")[0].textContent;
    expect(title(0)).toBe("The sample database");
    expect(title(1)).toBe("Statement 1 of 2");
    expect(title(trace.steps.length - 1)).toBe("Statement 2 of 2");
  });

  it("marks stages before and after this one", async () => {
    const trace = await traceOf("-- viz: database shop\nSELECT name FROM products WHERE price > 9 ORDER BY name;");
    const states = all(sqlPipelineDrawing(sqlPipelineScene(trace, 2)!), ".sql-stage").map(
      (g) => /is-(done|current|next)/.exec(g.getAttribute("class") ?? "")?.[1],
    );
    expect(states).toEqual(["done", "current", "next", "next"]);
  });
});

describe("colors", () => {
  const example = (name: string) => SQL_EXAMPLES.find((e) => e.name === name)!.code;
  const stepOf = (trace: Trace, kind: string) => trace.sql!.stages.findIndex((s) => s.kind === kind);
  const classes = (els: Element[]) => els.map((e) => e.getAttribute("class") ?? "");

  it("gives a join's lines a color for each key, dashes an outer join's, and draws rows that match nothing to NULL", async () => {
    const trace = await traceOf(example("LEFT JOIN keeps every row"));
    const scene = sqlTableScene(trace, stepOf(trace, "join"))!;
    const drawing = sqlTableDrawing(scene);
    const links = classes(all(drawing, ".sql-link"));
    expect(links.length).toBeGreaterThan(5);
    expect(links.every((c) => c.includes("is-outer"))).toBe(true);
    // Each customer's orders are one key: as many colors as customers with orders (up to six).
    expect(new Set(links.map((c) => /in-group-\d/.exec(c)?.[0])).size).toBeGreaterThan(3);
    expect(all(drawing, ".sql-unmatched")).toHaveLength(1);
    // The database's tables have colors; the joined rows have a dot for each, hollow where there was no match.
    expect(all(drawing, ".sql-table-mark")).toHaveLength(2);
    expect(all(drawing, ".sql-col-source").length).toBeGreaterThan(4);
    expect(all(drawing, ".sql-source.is-missing")).toHaveLength(1);

    const inner = await traceOf(example("JOIN … ON"));
    const plain = classes(all(sqlTableDrawing(sqlTableScene(inner, stepOf(inner, "join"))!), ".sql-link"));
    expect(plain.some((c) => c.includes("is-outer"))).toBe(false);
  });

  it("folds a group's rows into its row, in its color, and the color stays with the row after", async () => {
    const trace = await traceOf(example("GROUP BY"));
    const fold = sqlTableDrawing(sqlTableScene(trace, stepOf(trace, "aggregate"))!);
    const lines = classes(all(fold, ".sql-fold"));
    const rows = trace.sql!.stages[stepOf(trace, "group")].tables[0].rows;
    expect(lines).toHaveLength(rows.length);
    for (const [i, row] of rows.entries()) expect(lines[i]).toContain(`in-group-${row.group! % 6}`);
    const last = sqlTableDrawing(sqlTableScene(trace, trace.steps.length - 1)!);
    expect(all(last, ".sql-row").every((r) => /in-group-\d/.test(r.getAttribute("class") ?? ""))).toBe(true);
  });

  it("traces rows back through WITH to the database's tables", async () => {
    const trace = await traceOf(example("WITH"));
    const scene = sqlTableScene(trace, trace.steps.length - 1)!;
    const row = scene.stage.tables[0].rows[0];
    expect(
      scene
        .sources(row)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["customers", "orders", "products"]);
    expect(all(sqlTableDrawing(scene), ".sql-row")[0].querySelectorAll(".sql-source")).toHaveLength(3);
  });

  it("brackets each row's frame in a window step, in its partition's color", async () => {
    const trace = await traceOf(example("A running total"));
    const i = stepOf(trace, "window");
    const rows = trace.sql!.stages[i].tables[0].rows;
    // A running total: each row's frame runs from the first row to it (or the last it ties with).
    expect(rows[0].frame?.[0]).toBe(0);
    expect(rows.at(-1)!.frame).toEqual([0, rows.length - 1]);
    const brackets = all(sqlTableDrawing(sqlTableScene(trace, i)!), ".sql-frame");
    expect(brackets).toHaveLength(Math.min(rows.length, 10));
  });
});
