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

describe("joins", () => {
  const LEFT = `-- viz: database shop
SELECT c.name, o.id AS order_id
FROM customers AS c
LEFT JOIN orders AS o ON o.customer_id = c.id
ORDER BY c.name;`;

  it("are a step after FROM: the rows so far, the table joined, and the rows the join makes", async () => {
    const t = await trace(LEFT);
    expect(kinds(t)).toEqual(["tables", "from", "join", "select", "order"]);
    const join = stages(t)[2];
    expect(join.clause).toBe("LEFT JOIN orders AS o ON o.customer_id = c.id");
    expect(join.line).toBe(4);
    expect(join.tables.map((x) => [x.name, x.alias])).toEqual([
      ["customers", "c"],
      ["orders", "o"],
      ["joined", undefined],
    ]);
    // Every joined column, named by its table.
    expect(join.tables[2].columns.map((c) => c.name).slice(0, 5)).toEqual([
      "c.id",
      "c.name",
      "c.city",
      "c.joined",
      "o.id",
    ]);
  });

  it("pair rows up with lines, and keep a LEFT JOIN's unmatched rows with NULLs", async () => {
    const join = stages(await trace(LEFT))[2];
    expect(join.links).toHaveLength(14);
    expect(join.summary).toBe("14 matching pairs, 15 rows; 1 of customers AS c matches nothing: kept, with NULLs");
    // Linus (customer 8) has no orders.
    const linus = join.tables[0].rows.find((r) => r.values[1] === "Linus")!;
    expect([linus.status, linus.note]).toEqual(["unmatched", "no match: kept, with NULLs"]);
    const padded = join.tables[2].rows.find((r) => r.values[1] === "Linus")!;
    expect(padded.status).toBe("unmatched");
    expect(padded.values.slice(4)).toEqual([null, null, null, null, null]);
    expect(padded.label).toBe("#8·–");
    // Ada (customer 1) has four orders: four rows, four lines.
    expect(join.links?.filter((l) => l.from === join.tables[0].rows[0].id)).toHaveLength(4);
  });

  it("drop an inner join's unmatched rows from both sides", async () => {
    const t = await trace("-- viz: database shop\nSELECT p.name FROM orders o JOIN products p ON p.id = o.product_id;");
    const join = stages(t)[2];
    const dropped = join.tables[1].rows.filter((r) => r.status === "removed").map((r) => r.values[1]);
    expect(dropped).toEqual(["Earl Grey", "Cold brew kit"]);
    expect(join.summary).toBe("14 matching pairs, 14 rows; 2 of products AS p match nothing: left out");
  });

  it("follow three tables, one join at a time", async () => {
    const t = await trace(`-- viz: database shop
SELECT c.name, p.name AS product
FROM orders AS o
JOIN customers AS c ON c.id = o.customer_id
JOIN products AS p ON p.id = o.product_id
ORDER BY o.id
LIMIT 2;`);
    expect(kinds(t)).toEqual(["tables", "from", "join", "join", "select", "order", "limit"]);
    const [first, second] = stages(t).filter((s) => s.kind === "join");
    // The rows the first join makes are the rows the second starts from.
    expect(second.tables[0].rows.map((r) => r.id)).toEqual(first.tables[2].rows.map((r) => r.id));
    expect(second.tables[2].rows[0].label).toBe("#1·#1·#1");
    expect(values(stages(t)[6], "product")).toEqual(["Green tea", "Espresso beans"]);
  });

  it("tell the two copies of a table in a self join apart", async () => {
    const t = await trace(`-- viz: database company
SELECT e.name, m.name AS manager FROM employees AS e LEFT JOIN employees AS m ON m.id = e.manager_id ORDER BY e.id;`);
    const join = stages(t)[2];
    expect(join.tables[0].rows[0].id).toMatch(/^e:/);
    expect(join.tables[1].rows[0].id).toMatch(/^m:/);
    expect(
      stages(t)
        .at(-1)
        ?.tables[0].rows.slice(0, 2)
        .map((r) => r.values.slice(0, 2)),
    ).toEqual([
      ["Hana", null],
      ["Luis", "Hana"],
    ]);
  });

  it("keep both sides' unmatched rows in a FULL JOIN", async () => {
    const t = await trace(
      "-- viz: database company\nSELECT e.name, d.name FROM employees e FULL JOIN departments d ON d.id = e.department_id;",
    );
    const join = stages(t)[2];
    expect(join.tables[0].rows.filter((r) => r.status === "unmatched").map((r) => r.values[1])).toEqual(["Tariq"]);
    expect(join.tables[1].rows.filter((r) => r.status === "unmatched").map((r) => r.values[1])).toEqual(["Research"]);
  });

  it("pair every row with every row for CROSS JOIN and a comma, without lines", async () => {
    const t = await trace(
      "-- viz: database company\nSELECT d.name, e.name FROM departments d, employees e WHERE e.department_id = d.id;",
    );
    const join = stages(t)[2];
    expect(join.clause).toBe("CROSS JOIN employees AS e");
    expect(join.summary).toBe("4 × 11 = 44 rows: every row with every row");
    expect(join.links).toBeUndefined();
    expect(join.notes?.[0]).toMatch(/A comma between tables/);
    expect(stages(t)[3].summary).toBe("kept 10 of 44 rows");
  });

  it("join with USING and NATURAL, which merge the shared columns", async () => {
    const t = await trace(`CREATE TABLE a (id int, x text);
CREATE TABLE b (id int, y text);
INSERT INTO a VALUES (1, 'a1'), (2, 'a2');
INSERT INTO b VALUES (2, 'b2'), (3, 'b3');
SELECT * FROM a JOIN b USING (id);
SELECT * FROM a NATURAL FULL JOIN b ORDER BY id;`);
    const joins = stages(t).filter((s) => s.kind === "join");
    expect(joins.map((j) => j.clause)).toEqual(["JOIN b USING (id)", "NATURAL FULL JOIN b"]);
    expect(
      stages(t)
        .at(-1)
        ?.tables[0].rows.map((r) => r.values),
    ).toEqual([
      ["1", "a1", null],
      ["2", "a2", "b2"],
      ["3", null, "b3"],
    ]);
  });

  it("explain a column more than one table has", async () => {
    const t = await trace(
      "-- viz: database shop\nSELECT id FROM orders JOIN customers ON customers.id = orders.customer_id;",
    );
    expect(t.error?.message).toMatch(/orders and customers each have a column named "id": put the table's name/);
  });
});

describe("GROUP BY, aggregates and HAVING", () => {
  const GROUPED = `-- viz: database school
SELECT year, count(*) AS students, count(gpa) AS with_gpa
FROM students
GROUP BY year
HAVING count(gpa) >= 3
ORDER BY year;`;

  it("step after WHERE: the groups, each group's row, then HAVING", async () => {
    const t = await trace(GROUPED);
    expect(kinds(t)).toEqual(["tables", "from", "group", "aggregate", "having", "select", "order"]);
    expect(stages(t).map((s) => s.line)).toEqual([1, 3, 4, 2, 5, 2, 6]);
  });

  it("gather each group's rows together, marked with its group, saying what they share", async () => {
    const group = stages(await trace(GROUPED))[2];
    expect(group.summary).toBe("4 groups of 12 rows");
    const table = group.tables[0];
    expect(table.groups?.map((g) => [g.label, g.count])).toEqual([
      ["year = 2", 3],
      ["year = 1", 4],
      ["year = 3", 3],
      ["year = 4", 2],
    ]);
    // In order of the groups, each row marked with its group, and the key worked out.
    expect(table.rows.map((r) => r.group)).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3]);
    expect(table.columns.at(-1)).toMatchObject({ name: "year", role: "key" });
  });

  it("make each group one row, with the values each aggregate was given", async () => {
    const aggregate = stages(await trace(GROUPED))[3];
    const table = aggregate.tables[0];
    expect(table.columns.map((c) => [c.name, c.role])).toEqual([
      ["year", "key"],
      ["count(*)", "computed"],
      ["rows", "inputs"],
      ["count(gpa)", "computed"],
      ["gpa values", "inputs"],
    ]);
    // Year 1: four rows, one with no GPA, which COUNT(gpa) leaves out.
    expect(table.rows[1].values).toEqual(["1", "4", "#2, #4, #9, #12", "3", "3.20, NULL, 2.40, 3.65"]);
    expect(table.rows.map((r) => r.label)).toEqual(["G1", "G2", "G3", "G4"]);
  });

  it("drop whole groups with HAVING, and follow the groups through to the result", async () => {
    const t = await trace(GROUPED);
    const having = stages(t)[4];
    expect(having.summary).toBe("kept 2 of 4 groups");
    expect(having.tables[0].rows.filter((r) => r.status === "removed").map((r) => r.values[0])).toEqual(["3", "4"]);
    const order = stages(t)[6];
    expect(order.tables[0].rows.map((r) => [r.label, ...r.values])).toEqual([
      ["G2", "1", "4", "3"],
      ["G1", "2", "3", "3"],
    ]);
    // A group's row is its first row's id: the row it slides from.
    expect(order.tables[0].rows[1].id).toBe(stages(t)[2].tables[0].rows[0].id);
  });

  it("make every row one group for an aggregate without GROUP BY, even with no rows", async () => {
    const t = await trace("-- viz: database shop\nSELECT count(*), sum(stock) FROM products WHERE price > 100;");
    expect(kinds(t)).toEqual(["tables", "from", "where", "group", "aggregate", "select"]);
    expect(stages(t)[3].notes?.[0]).toMatch(/every row is one group/);
    expect(stages(t).at(-1)?.tables[0].rows[0].values).toEqual(["0", null]);
  });

  it("group by a SELECT name or position as the query does", async () => {
    const t = await trace(
      "-- viz: database shop\nSELECT upper(category) AS shelf, count(*) FROM products GROUP BY shelf ORDER BY 1;",
    );
    expect(stages(t).find((s) => s.kind === "group")?.tables[0].groups?.[0].label).toBe("upper(category) = TEA");
    const u = await trace(
      "-- viz: database shop\nSELECT category, count(*) FROM products GROUP BY 1 ORDER BY 2 DESC, 1;",
    );
    expect(u.sql?.statements[1].unsupported).toBeUndefined();
  });

  it("show the refused column's values in each group, for SELECT's GROUP BY error", async () => {
    const t = await trace("-- viz: database shop\nSELECT category, name\nFROM products\nGROUP BY category;");
    expect(t.error?.message).toMatch(/must appear in the GROUP BY clause/);
    expect(t.error?.message).toMatch(/The GROUP BY step shows a group/);
    expect(kinds(t)).toEqual(["tables", "from", "group"]);
    const group = stages(t)[2];
    expect(group.tables[0].columns.at(-1)).toMatchObject({ name: "products.name", role: "problem" });
    expect(group.notes?.[0]).toMatch(
      /^In G1 \(category = Tea\), products.name has 4 different values: Green tea, Earl Grey, Oolong, Chai\./,
    );
  });
});

describe("subqueries, WITH and set operations", () => {
  const partsOf = (t: Trace) => stages(t).map((s) => `${s.part ? `${s.part.label}/` : ""}${s.kind}`);

  it("step through a subquery that stands alone first, and call it by its number", async () => {
    const t = await trace(
      "-- viz: database shop\nSELECT name FROM products WHERE price > (SELECT avg(price) FROM products) ORDER BY price;",
    );
    expect(partsOf(t)).toEqual([
      "tables",
      "Subquery 1/from",
      "Subquery 1/group",
      "Subquery 1/aggregate",
      "Subquery 1/select",
      "from",
      "where",
      "select",
      "order",
    ]);
    expect(stages(t)[1].part?.depth).toBe(1);
    expect(stages(t)[6].clause).toBe("WHERE price > (subquery 1)");
    // A part's steps don't fuss about its order: the outer query decides.
    expect(stages(t)[4].notes).toBeUndefined();
  });

  it("run a subquery that uses the outer row once per row, shown before its clause", async () => {
    const t = await trace(`-- viz: database shop
SELECT c.name FROM customers AS c
WHERE EXISTS (SELECT 1 FROM orders AS o WHERE o.customer_id = c.id AND o.quantity > 1);`);
    expect(partsOf(t)).toEqual(["tables", "from", "subquery", "where", "select"]);
    const each = stages(t)[2];
    expect(each.clause).toBe("Subquery 1, for each row");
    expect(each.summary).toBe("run 8 times: once for each row, with its c.id");
    expect(each.tables[0].columns.map((c) => [c.name, c.role])).toEqual([
      ["c.id", "outer"],
      ["EXISTS (subquery 1)", "check"],
    ]);
    expect(each.tables[0].rows.map((r) => r.values[1])).toEqual([
      "true",
      "true",
      "true",
      "true",
      "true",
      "false",
      "false",
      "false",
    ]);
  });

  it("warn about NOT IN with a NULL", async () => {
    const t = await trace(
      "-- viz: database company\nSELECT name FROM departments WHERE id NOT IN (SELECT department_id FROM employees);",
    );
    const where = stages(t).find((s) => s.kind === "where")!;
    expect(where.summary).toBe("kept 0 of 4 rows");
    expect(where.notes?.[0]).toMatch(/^Subquery 1 gives a NULL, so NOT IN is never true/);
  });

  it("step through WITH queries first, then read them as tables", async () => {
    const t = await trace(`-- viz: database shop
WITH cheap AS (SELECT id, name FROM products WHERE price < 8),
     ordered AS (SELECT DISTINCT product_id FROM orders)
SELECT cheap.name FROM cheap JOIN ordered ON ordered.product_id = cheap.id ORDER BY cheap.name;`);
    expect(partsOf(t)).toEqual([
      "tables",
      "WITH cheap/from",
      "WITH cheap/where",
      "WITH cheap/select",
      "WITH ordered/from",
      "WITH ordered/select",
      "WITH ordered/distinct",
      "from",
      "join",
      "select",
      "order",
    ]);
    expect(stages(t)[7].tables[0].name).toBe("cheap");
    expect(
      stages(t)
        .at(-1)
        ?.tables[0].rows.map((r) => r.values[0]),
    ).toEqual(["Chai", "Green tea", "Honey"]);
  });

  it("drop WITH's tables after the statement", async () => {
    const t = await trace(
      "-- viz: database shop\nWITH cheap AS (SELECT 1 AS x) SELECT * FROM cheap;\nSELECT * FROM cheap;",
    );
    expect(t.error?.message).toMatch(/relation "cheap" does not exist/);
  });

  it("step through a subquery in FROM, then read it as a table", async () => {
    const t = await trace(
      "-- viz: database shop\nSELECT s.category, s.n FROM (SELECT category, count(*) AS n FROM products GROUP BY category) AS s WHERE s.n > 2;",
    );
    expect(partsOf(t).slice(0, 5)).toEqual([
      "tables",
      "Subquery AS s/from",
      "Subquery AS s/group",
      "Subquery AS s/aggregate",
      "Subquery AS s/select",
    ]);
    expect(stages(t).at(-1)?.rows).toBe(3);
  });

  it("step through both sides of a UNION, then put them together", async () => {
    const t = await trace(
      "-- viz: database shop\nSELECT city FROM customers UNION SELECT category FROM products ORDER BY 1 LIMIT 5;",
    );
    expect(partsOf(t)).toEqual([
      "tables",
      "UNION: the first query/from",
      "UNION: the first query/select",
      "UNION: the second query/from",
      "UNION: the second query/select",
      "combine",
      "order",
      "limit",
    ]);
    const combine = stages(t)[5];
    expect(combine.summary).toBe("8 rows and 12 rows: 9 rows, every row of both, each different row once");
    expect(combine.tables.map((x) => x.name)).toEqual(["first query", "second query", "UNION"]);
    expect(combine.tables[2].rows.find((r) => r.values[0] === "London" && r.status)?.note).toBe("same as #1");
    expect(
      stages(t)
        .at(-1)
        ?.tables[0].rows.filter((r) => !r.status)
        .map((r) => r.values[0]),
    ).toEqual(["Austin", "Boston", "Coffee", "Helsinki", "Kitchen"]);
  });

  it("keep and drop rows as INTERSECT, EXCEPT and their ALL kinds do", async () => {
    const q = (op: string) => `SELECT x FROM a ${op} SELECT x FROM b`;
    const t = await trace(`CREATE TABLE a (x int); CREATE TABLE b (x int);
INSERT INTO a VALUES (1), (1), (2), (3); INSERT INTO b VALUES (1), (3), (3);
${q("INTERSECT")}; ${q("INTERSECT ALL")}; ${q("EXCEPT")}; ${q("EXCEPT ALL")}; ${q("UNION ALL")};`);
    const made = stages(t)
      .filter((s) => s.kind === "combine")
      .map((s) => s.tables[2].rows.filter((r) => r.status !== "removed").map((r) => r.values[0]));
    expect(made).toEqual([["1", "3"], ["1", "3"], ["2"], ["1", "2"], ["1", "1", "2", "3", "1", "3", "3"]]);
  });

  it("show which branch of a CASE each row took", async () => {
    const t = await trace(
      "-- viz: database shop\nSELECT name, CASE WHEN price < 8 THEN 'cheap' WHEN price < 20 THEN 'middle' END AS band FROM products;",
    );
    const select = stages(t).find((s) => s.kind === "select")!;
    expect(select.tables[0].columns.at(-1)).toMatchObject({ name: "band: which", role: "case" });
    expect(select.tables[0].rows.slice(0, 3).map((r) => r.values.slice(1))).toEqual([
      ["cheap", "WHEN price < 8"],
      ["cheap", "WHEN price < 8"],
      ["middle", "WHEN price < 20"],
    ]);
    expect(select.tables[0].rows[5].values.slice(1)).toEqual([null, "ELSE (NULL)"]);
  });
});

describe("window functions", () => {
  it("are a step before SELECT: every row in its partition, worked out from its frame", async () => {
    const t = await trace(`-- viz: database company
SELECT name, sum(salary) OVER (PARTITION BY department_id ORDER BY hired) AS running
FROM employees WHERE department_id IS NOT NULL;`);
    expect(kinds(t)).toEqual(["tables", "from", "where", "window", "select"]);
    const w = stages(t)[3];
    const table = w.tables[0];
    expect(table.groupKind).toBe("partition");
    expect(table.groups?.map((g) => [g.label, g.count])).toEqual([
      ["department_id = 1", 4],
      ["department_id = 2", 3],
      ["department_id = 3", 3],
    ]);
    expect(table.columns.slice(-4).map((c) => [c.name, c.role])).toEqual([
      ["department_id", "key"],
      ["sum(salary)", "computed"],
      ["frame", "inputs"],
      ["salary values", "inputs"],
    ]);
    // Mei, the third hired in Engineering: her frame is the three up to her.
    expect(table.rows[2].values.slice(-3)).toEqual(["24200", "#1, #2, #3", "9800, 7200, 7200"]);
    expect(w.notes?.[0]).toMatch(/running total/);
  });

  it("show a frame set by hand", async () => {
    const t = await trace(
      "-- viz: database shop\nSELECT id, sum(quantity) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) FROM orders;",
    );
    const w = stages(t).find((s) => s.kind === "window")!;
    expect(w.tables[0].rows[4].values.slice(-2)).toEqual(["#3, #4, #5", "1, 3, 1"]);
    expect(w.notes?.[0]).toBe("Each row's frame is set by the window: ROWS BETWEEN 2 PRECEDING AND CURRENT ROW.");
  });

  it("number rows for rank, without a frame", async () => {
    const t = await trace(
      "-- viz: database company\nSELECT name, rank() OVER (ORDER BY salary DESC) FROM employees ORDER BY 2, 1 LIMIT 4;",
    );
    const w = stages(t).find((s) => s.kind === "window")!;
    expect(w.tables[0].columns.some((c) => c.name === "frame")).toBe(false);
    expect(w.notes?.[0]).toMatch(/rank skips numbers after a tie/);
    expect(
      stages(t)
        .at(-1)
        ?.tables[0].rows.filter((r) => !r.status)
        .map((r) => r.values),
    ).toEqual([
      ["Hana", "1"],
      ["Luis", "2"],
      ["Mei", "2"],
      ["Victor", "4"],
    ]);
  });
});

describe("WITH RECURSIVE", () => {
  it("steps pass by pass, each pass reading the rows the one before made", async () => {
    const t = await trace(
      "WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT i FROM n;",
    );
    expect(stages(t).map((s) => `${s.kind} ${s.clause}`)).toEqual([
      "select SELECT 1",
      "pass Pass 1",
      "pass Pass 2",
      "pass Pass 3",
      "pass All passes together",
      "from FROM n",
      "select SELECT i",
    ]);
    const [, first, second, last] = stages(t);
    expect(first.summary).toBe("1 new row, from the starting rows");
    expect(second.tables[0].rows[0].id).toBe(first.tables[1].rows[0].id);
    expect(last.summary).toBe("no new rows from the 1 row pass 2 made: done");
    expect(first.part?.label).toBe("WITH RECURSIVE n");
  });

  it("with UNION, skips rows found already, so a cycle ends", async () => {
    const t = await trace(`CREATE TABLE edges (a int, b int);
INSERT INTO edges VALUES (1, 2), (2, 3), (3, 1);
WITH RECURSIVE reach (node) AS (SELECT 1 UNION SELECT e.b FROM edges e JOIN reach r ON e.a = r.node)
SELECT node FROM reach ORDER BY node;`);
    const passes = stages(t).filter((s) => s.kind === "pass");
    expect(passes.map((p) => p.rows)).toEqual([1, 1, 0, 3]);
    expect(passes[2].tables[1].rows[0]).toMatchObject({ values: ["1"], status: "removed", note: "found already" });
  });
});

describe("changing tables, before and after", () => {
  const SETUP =
    "CREATE TABLE pets (name text, age int);\nINSERT INTO pets VALUES ('Rex', 3), ('Tom', NULL), ('Kit', 1);\n";

  it("UPDATE steps through its WHERE, then shows the table before and after", async () => {
    const t = await trace(`${SETUP}UPDATE pets SET age = age + 1 WHERE age < 5;`);
    expect(kinds(t)).toEqual(["statement", "statement", "where", "statement"]);
    const where = stages(t)[2];
    expect(where.summary).toBe("picks 2 of 3 rows to change");
    expect(where.tables[0].rows.map((r) => r.note)).toEqual([
      "picked: to change",
      "NULL: unknown, so not picked",
      "picked: to change",
    ]);
    const update = stages(t)[3];
    expect(update.tables.map((x) => x.name)).toEqual(["pets (before)", "pets (after)"]);
    expect(update.tables[1].rows.filter((r) => r.status === "changed").map((r) => r.note)).toEqual([
      "was #1: age 3 → 4",
      "was #3: age 1 → 2",
    ]);
  });

  it("DELETE steps through its WHERE, then shows the rows gone", async () => {
    const t = await trace(`${SETUP}DELETE FROM pets WHERE age IS NULL;`);
    const del = stages(t).at(-1)!;
    expect(del.tables[0].rows.filter((r) => r.status === "removed").map((r) => r.values[0])).toEqual(["Tom"]);
    expect(del.tables[1].rows.map((r) => r.values[0])).toEqual(["Rex", "Kit"]);
  });
});

describe("refused statements", () => {
  it("show the row already holding a unique key", async () => {
    const t = await trace("-- viz: database shop\nINSERT INTO customers VALUES (3, 'Ann', 'Leeds', '2024-01-01');");
    expect(t.error?.message).toMatch(/duplicate key value/);
    const refused = stages(t).at(-1)!;
    expect(refused.kind).toBe("refused");
    expect(refused.summary).toBe("customers already has a row with id = 3");
    expect(refused.tables[0].rows.filter((r) => r.status).map((r) => [r.values[1], r.note])).toEqual([
      ["Alan", "already has this key"],
    ]);
    expect(refused.notes?.[0]).toBe("Refused: nothing changed. The rule: PRIMARY KEY (id).");
  });

  it("show the rows that still point at a row being deleted", async () => {
    const t = await trace("-- viz: database shop\nDELETE FROM customers WHERE id = 2;");
    const refused = stages(t).at(-1)!;
    expect(refused.summary).toBe("rows of orders still point at id = 2");
    expect(refused.tables[0].name).toBe("orders");
    expect(refused.tables[0].rows.filter((r) => r.status).map((r) => r.values[0])).toEqual(["2", "5", "11"]);
  });

  it("show the table a key isn't in, and a CHECK rule", async () => {
    const missing = await trace("-- viz: database transit\nINSERT INTO connections VALUES (1, 99, 3);");
    expect(stages(missing).at(-1)?.summary).toBe("stations has no row with to_station = 99");
    const check = await trace("-- viz: database transit\nINSERT INTO connections VALUES (1, 10, 0);");
    expect(stages(check).at(-1)?.summary).toBe("a row of connections would break its rule CHECK ((minutes > 0))");
  });
});

describe("what isn't stepped through yet", () => {
  for (const [query, why] of [
    ["SELECT category, count(*) FROM products GROUP BY ROLLUP (category)", "ROLLUP"],
    ["SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FROM products", "WITHIN GROUP"],
    ["SELECT * FROM orders JOIN (customers JOIN products ON true) ON true", "joins in parentheses"],
    ["SELECT * FROM orders, customers JOIN products ON true", "a mix of commas and JOIN"],
    ["SELECT name, rank() OVER w FROM products WINDOW w AS (ORDER BY price)", "named windows"],
    [
      "SELECT category, count(*), rank() OVER (ORDER BY count(*)) FROM products GROUP BY category",
      "window functions with GROUP BY",
    ],
    ["SELECT ARRAY(SELECT name FROM products)", "this kind of subquery"],
    ["SELECT * FROM customers c, LATERAL (SELECT * FROM orders o WHERE o.customer_id = c.id) x", "LATERAL"],
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
    expect(kinds(t)).toEqual([
      "statement",
      "statement",
      "where",
      "statement",
      "where",
      "statement",
      "from",
      "select",
      "order",
    ]);
    const [create, insert, , update, , del] = stages(t);
    expect(create.summary).toBe("made the table pets");
    expect(insert.tables[0].rows.map((r) => r.status)).toEqual(["added", "added", "added"]);
    expect(update.summary).toBe("changed 1 row");
    expect(update.tables[1].rows.filter((r) => r.status === "changed").map((r) => r.values)).toEqual([["Rex", "4"]]);
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
