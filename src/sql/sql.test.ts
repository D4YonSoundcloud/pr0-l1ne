/**
 * The SQL tracer, on the Postgres the browser runs (PGlite, in Node).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { traceProblem } from "../trace/checkTrace";
import { applyHints } from "../trace/hints";
import type { SqlStage, Trace } from "../trace/types";
import { traceProblems } from "../trace/validate";
import { SAMPLE_DATABASES } from "./databases";
import { PgliteEngine } from "./engine";
import { loadParser, type SqlParser } from "./parser";
import { oneLine, readHints, SourceText, skipToCode } from "./script";
import { formatResult, traceSql } from "./trace";

let engine: PgliteEngine;
let parser: SqlParser;

beforeAll(async () => {
  engine = await PgliteEngine.create();
  parser = await loadParser();
}, 60_000);

async function trace(source: string): Promise<Trace> {
  const t = await traceSql(source, engine, parser);
  expect(traceProblems(t), "matches the trace schema").toEqual([]);
  expect(traceProblem(t), "the app accepts it").toBeNull();
  expect(t.steps.length).toBe(t.sql?.stages.length);
  return t;
}

const stages = (t: Trace) => t.sql?.stages ?? [];
const kinds = (t: Trace) => stages(t).map((s) => s.kind);
const kept = (s: SqlStage) => s.tables[0].rows.filter((r) => r.status !== "removed");
const column = (s: SqlStage, name: string) => s.tables[0].columns.findIndex((c) => c.name === name);
const values = (s: SqlStage, name: string) => kept(s).map((r) => r.values[column(s, name)]);

describe("the script", () => {
  it("counts lines in characters, though the parser counts bytes", () => {
    const text = new SourceText("-- é\nSELECT 'ü';\nSELECT 2;");
    // "-- é\n" is 6 bytes, 5 characters.
    expect(text.char(6)).toBe(5);
    expect(text.lineOf(6)).toBe(2);
    expect(text.slice(6, 18)).toBe("SELECT 'ü';");
  });

  it("finds where a statement's code starts, past comments", () => {
    const text = "\n  -- a comment\n/* another */ SELECT 1";
    expect(text.slice(skipToCode(text))).toBe("SELECT 1");
  });

  it("reads the database hint, and keeps the hints it doesn't know", () => {
    const hints = readHints("-- viz: database Shop\n-- viz: hide x\nSELECT 1;");
    expect(hints.database).toEqual({ name: "Shop", line: 1 });
    expect(hints.unknown).toEqual([{ line: 2, text: "hide x" }]);
  });

  it("shortens text to one line", () => {
    expect(oneLine("SELECT a,\n   b\nFROM t")).toBe("SELECT a, b FROM t");
    expect(oneLine("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("a query, clause by clause", () => {
  const QUERY = `-- viz: database shop
SELECT name, price, price * stock AS stock_value
FROM products
WHERE category = 'Tea' OR price > 20
ORDER BY price DESC, name
LIMIT 4 OFFSET 1;`;

  it("steps in the order the clauses mean, not the order they're written", async () => {
    const t = await trace(QUERY);
    expect(kinds(t)).toEqual(["tables", "from", "where", "select", "order", "limit"]);
    expect(stages(t).map((s) => s.line)).toEqual([1, 3, 4, 2, 5, 6]);
    expect(t.error).toBeNull();
  });

  it("starts with the sample database's tables", async () => {
    const [tables] = stages(await trace(QUERY));
    expect(tables.tables.map((x) => x.name)).toEqual(["customers", "products", "orders"]);
    expect(tables.tables[1].rows).toHaveLength(12);
  });

  it("works out WHERE's condition, and each part of it, for every row", async () => {
    const where = stages(await trace(QUERY))[2];
    const columns = where.tables[0].columns;
    expect(columns.slice(-3).map((c) => [c.name, c.role])).toEqual([
      ["category = 'Tea'", "check"],
      ["price > 20", "check"],
      ["kept?", "result"],
    ]);
    expect(where.summary).toBe("kept 7 of 12 rows");
    // Honey has no category: NULL = 'Tea' is unknown, and unknown OR false is unknown.
    const honey = where.tables[0].rows.find((r) => r.values[1] === "Honey")!;
    expect(honey.values.slice(-3)).toEqual([null, "false", null]);
    expect(honey.status).toBe("removed");
    expect(honey.note).toMatch(/unknown/);
    // Gift card has no category either, but it's over 20: unknown OR true is true.
    const gift = where.tables[0].rows.find((r) => r.values[1] === "Gift card")!;
    expect(gift.values.slice(-3)).toEqual([null, "true", "true"]);
    expect(gift.status).toBeUndefined();
  });

  it("keeps each row's id from step to step", async () => {
    const t = await trace(QUERY);
    const ids = (s: SqlStage) => s.tables[0].rows.map((r) => r.id);
    const [, from, , select, order] = stages(t);
    expect(ids(select).every((id) => ids(from).includes(id))).toBe(true);
    expect(new Set(ids(order))).toEqual(new Set(ids(select)));
    // And its label from FROM: "#12" is the twelfth row of products.
    expect(select.tables[0].rows.find((r) => r.values[0] === "Gift card")?.label).toBe("#12");
  });

  it("marks computed columns and sort keys", async () => {
    const t = await trace(QUERY);
    const select = stages(t)[3];
    expect(select.tables[0].columns.map((c) => c.role ?? "")).toEqual(["", "", "computed"]);
    expect(select.tables[0].columns[2].expr).toBe("price * stock");
    const order = stages(t)[4];
    expect(order.tables[0].columns.map((c) => c.sort)).toEqual([
      { rank: 2, desc: false },
      { rank: 1, desc: true },
      undefined,
    ]);
    expect(values(order, "name")).toEqual([
      "Cold brew kit",
      "Gift card",
      "Teapot",
      "Oolong",
      "Earl Grey",
      "Chai",
      "Green tea",
    ]);
  });

  it("cuts at OFFSET and LIMIT", async () => {
    const limit = stages(await trace(QUERY))[5];
    expect(limit.tables[0].cuts).toEqual([
      { before: 1, label: "OFFSET 1" },
      { before: 5, label: "LIMIT 4" },
    ]);
    expect(values(limit, "name")).toEqual(["Gift card", "Teapot", "Oolong", "Earl Grey"]);
    expect(limit.tables[0].rows[0].note).toBe("skipped by OFFSET 1");
    expect(limit.tables[0].rows[6].note).toBe("past LIMIT 4");
  });

  it("prints the result as psql does", async () => {
    const t = await trace(QUERY);
    expect(t.stdout).toBe(
      [
        "   name    | price | stock_value",
        "-----------+-------+-------------",
        " Gift card | 25.00 |     2500.00",
        " Teapot    | 24.00 |       72.00",
        " Oolong    |  9.00 |      162.00",
        " Earl Grey |  7.25 |        0.00",
        "(4 rows)",
        "",
        "",
      ].join("\n"),
    );
    // Printed on the query's last step.
    expect(t.steps.map((s) => s.stdoutLength)).toEqual([0, 0, 0, 0, 0, t.stdout.length]);
  });
});

describe("DISTINCT, ties and order", () => {
  it("drops repeated rows, keeping the first of each", async () => {
    const t = await trace("-- viz: database school\nSELECT DISTINCT city FROM students ORDER BY city;");
    expect(kinds(t)).toEqual(["tables", "from", "select", "distinct", "order"]);
    const distinct = stages(t)[3];
    expect(distinct.summary).toBe("3 different rows of 12");
    expect(distinct.tables[0].rows[2].note).toBe("same as #1");
    expect(values(stages(t)[4], "city")).toEqual(["Hull", "Leeds", "York"]);
  });

  it("marks rows that tie, and says their order isn't promised", async () => {
    const t = await trace("-- viz: database company\nSELECT name, salary FROM employees ORDER BY salary DESC;");
    const order = stages(t)[3];
    expect(order.tables[0].rows.filter((r) => r.tie).length).toBe(3);
    expect(order.notes?.[0]).toMatch(/either order/);
  });

  it("says when there's no ORDER BY", async () => {
    const t = await trace("-- viz: database school\nSELECT name FROM students WHERE year = 1;");
    expect(stages(t).at(-1)?.notes?.[0]).toMatch(/No ORDER BY/);
  });

  it("works out a sort key that isn't a column of the result", async () => {
    const t = await trace("-- viz: database shop\nSELECT name FROM products ORDER BY price * stock DESC LIMIT 2;");
    const order = stages(t)[3];
    const key = order.tables[0].columns[1];
    expect([key.name, key.role, key.sort]).toEqual(["price * stock", "sort", { rank: 1, desc: true }]);
    expect(order.tables[0].rows[0].values).toEqual(["Gift card", "2500.00"]);
  });

  it("follows ORDER BY a column's position", async () => {
    const t = await trace("-- viz: database shop\nSELECT name, price FROM products ORDER BY 2, 1 LIMIT 3;");
    expect(values(stages(t)[4], "name")).toEqual(["Chai", "Green tea", "Earl Grey"]);
  });
});

describe("what isn't stepped through yet", () => {
  for (const [query, why] of [
    ["SELECT count(*) FROM products", "aggregate"],
    ["SELECT category, max(price) FROM products GROUP BY category", "GROUP BY"],
    ["SELECT * FROM orders JOIN customers ON customers.id = orders.customer_id", "joins"],
    ["SELECT name FROM products WHERE price > (SELECT avg(price) FROM products)", "aggregate"],
    ["SELECT name FROM products UNION SELECT name FROM customers", "UNION"],
    ["SELECT * FROM generate_series(1, 3)", "functions in FROM"],
    ["SELECT name, random() FROM products", "random"],
  ]) {
    it(`shows the result of: ${query}`, async () => {
      const t = await trace(`-- viz: database shop\n${query};`);
      expect(kinds(t)).toEqual(["tables", "result"]);
      expect(stages(t)[1].notes?.[0]).toContain(why);
      expect(t.sql?.statements[1].unsupported).toBeTruthy();
    });
  }

  it("steps through a SELECT with no FROM as one step", async () => {
    const t = await trace("SELECT 1 + 1 AS two;");
    expect(kinds(t)).toEqual(["select"]);
    expect(stages(t)[0].tables[0].rows[0].values).toEqual(["2"]);
    expect(stages(t)[0].tables[0].columns[0].role).toBe("computed");
  });
});

describe("statements that change tables", () => {
  const SCRIPT = `CREATE TABLE pets (name text, age int);
INSERT INTO pets VALUES ('Rex', 3), ('Tom', NULL), ('Kit', 1);
UPDATE pets SET age = 4 WHERE name = 'Rex';
DELETE FROM pets WHERE age IS NULL;
SELECT * FROM pets ORDER BY age;`;

  it("are a step each, with the rows they changed marked", async () => {
    const t = await trace(SCRIPT);
    expect(kinds(t)).toEqual(["statement", "statement", "statement", "statement", "from", "select", "order"]);
    const [create, insert, update, del] = stages(t);
    expect(create.summary).toBe("made the table pets");
    expect(insert.tables[0].rows.map((r) => r.status)).toEqual(["added", "added", "added"]);
    expect(update.summary).toBe("changed 1 row");
    expect(update.tables[0].rows.filter((r) => r.status === "changed").map((r) => r.values)).toEqual([["Rex", "4"]]);
    expect(del.tables[0].rows.filter((r) => r.status === "removed").map((r) => r.values)).toEqual([["Tom", null]]);
    expect(t.stdout).toMatch(/^CREATE TABLE\nINSERT 0 3\nUPDATE 1\nDELETE 1\n/);
  });

  it("start every run from a fresh database", async () => {
    await trace(SCRIPT);
    const again = await trace(SCRIPT);
    expect(again.error).toBeNull();
    const bare = await trace("SELECT * FROM pets;");
    expect(bare.error?.message).toMatch(/does not exist/);
  });

  it("can't change the sample database for the next run", async () => {
    await trace("-- viz: database shop\nDELETE FROM orders;\nDROP TABLE orders;");
    const t = await trace("-- viz: database shop\nSELECT * FROM orders;");
    expect(stages(t)[1].summary).toBe("orders: 14 rows");
  });
});

describe("errors", () => {
  it("say where, and what usually causes them", async () => {
    const t = await trace("-- viz: database shop\nSELECT name\nFROM products\nWHERE prise > 10;");
    expect(t.error?.line).toBe(4);
    expect(t.error?.message).toMatch(/^column "prise" does not exist\. products has "id", "name"/);
    // What ran before the error is still there to step through.
    expect(kinds(t)).toEqual(["tables"]);
  });

  it("explain why a SELECT name can't be used in WHERE", async () => {
    const t = await trace("-- viz: database shop\nSELECT price * 2 AS double FROM products WHERE double > 10;");
    expect(t.error?.message).toMatch(/WHERE runs before SELECT/);
  });

  it("suggest a sample database when there are no tables", async () => {
    const t = await trace("SELECT * FROM products;");
    expect(t.error?.message).toMatch(/viz: database shop/);
    expect(t.steps).toEqual([]);
  });

  it("point at a syntax error's line", async () => {
    const t = await trace("-- viz: database shop\nSELECT name\nFROM products\nWHERE price >;");
    expect(t.error?.line).toBe(4);
    expect(t.error?.message).toMatch(/^Syntax error at or near ";"/);
  });

  it("name the sample databases when the hint asks for one there isn't", async () => {
    const t = await trace("-- viz: database shops\nSELECT 1;");
    expect(t.error?.line).toBe(1);
    for (const db of SAMPLE_DATABASES) expect(t.error?.message).toContain(db.name);
  });

  it("refuse transactions, which a run doesn't need", async () => {
    const t = await trace("BEGIN;\nSELECT 1;");
    expect(t.error?.message).toMatch(/aren't needed here/);
  });

  it("keep going after a step's own query fails: the result is shown instead", async () => {
    // Each part alone fails on the row with b = 0; the whole condition doesn't.
    const t = await trace(
      "CREATE TABLE t (a int, b int);\nINSERT INTO t VALUES (4, 2), (1, 0);\nSELECT a FROM t WHERE b <> 0 AND a / b > 1;",
    );
    expect(t.error).toBeNull();
    const where = stages(t).find((s) => s.kind === "where")!;
    expect(where.tables[0].columns.at(-1)?.role).toBe("result");
    expect(where.tables[0].columns.some((c) => c.role === "check")).toBe(false);
    expect(kept(where)).toHaveLength(1);
  });
});

describe("hints", () => {
  it("warns about hints SQL doesn't have", async () => {
    const t = applyHints(await trace("-- viz: database shop\n-- viz: hide x\nSELECT 1;"));
    expect(t.viz?.warnings).toEqual([
      { line: 2, message: 'Unknown hint "hide x". SQL has one: viz: database <name>.' },
    ]);
  });
});

describe("psql's table", () => {
  it("lines up text on the left and numbers on the right", () => {
    expect(
      formatResult({
        columns: [
          { name: "n", type: "integer", numeric: true },
          { name: "word", type: "text", numeric: false },
        ],
        rows: [
          ["10", "hi"],
          ["2", null],
        ],
      }),
    ).toBe(" n  | word\n----+------\n 10 | hi\n  2 |\n(2 rows)\n");
  });
});

describe("the sample databases", () => {
  it("each load, with fewer than 15 rows a table", async () => {
    for (const db of SAMPLE_DATABASES) {
      const t = await trace(`-- viz: database ${db.name}\nSELECT 1;`);
      expect(t.error).toBeNull();
      for (const table of stages(t)[0].tables) expect(table.rows.length).toBeLessThan(15);
    }
  });
});
