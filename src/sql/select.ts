/**
 * Stepping through a SELECT: one table per clause, in the order Postgres
 * gives the clauses meaning, not the order they're written:
 *
 *   FROM      the table, every row
 *   JOIN      each other table, joined to the rows so far
 *   WHERE     each row's condition worked out: kept if it's true
 *   SELECT    the columns asked for, computed ones worked out
 *   DISTINCT  repeated rows dropped
 *   ORDER BY  the rows in order (ties marked: their order isn't promised)
 *   LIMIT     the rows past the cut (and those OFFSET skips) dropped
 *
 * Each step's table comes from a smaller query run on the same database:
 * the FROM alone, then with the WHERE, and so on, each written from the
 * query's own parse tree, so every value is the one Postgres works out.
 * Rows are followed from step to step by where Postgres keeps them (ctid),
 * which doesn't change while the statement only reads.
 *
 * Then the last step is checked against the query's own result. If they
 * differ, the steps are dropped and the result is shown instead: a picture
 * of the wrong rows would be worse than none.
 *
 * With several tables, FROM is the first table, then a JOIN step for each
 * table joined to the rows so far (a comma in FROM is a CROSS JOIN): the
 * rows so far, the table joined, the pairs that match, and the rows the
 * join makes, unmatched rows kept with NULLs by LEFT, RIGHT and FULL JOIN.
 * Joins are followed left to right, as Postgres reads them.
 *
 * Anything else (GROUP BY, subqueries...) is shown as its result, saying
 * what isn't stepped through yet: see unsupported().
 */
import type { SqlColumn, SqlRow, SqlStage, SqlTable } from "../trace/types";
import type { Engine, QueryResult, ResultColumn } from "./engine";
import type { Node, SqlParser } from "./parser";
import { oneLine } from "./script";

/** Rows drawn at a step at most; the rest are counted. */
export const MAX_ROWS = 100;

export interface SelectContext {
  engine: Engine;
  parser: SqlParser;
  /** The statement's index in the script. */
  statement: number;
  /** Its first line. */
  line: number;
  /** The line of a byte offset in the script (the parse tree's locations). */
  lineOf(byteOffset: number): number;
}

// ---------------------------------------------------------------- reading the parse tree

/** Every node in a tree, with its type: `visit("ColumnRef", body)`. */
function walk(tree: unknown, visit: (type: string, body: Node) => void): void {
  if (Array.isArray(tree)) {
    for (const item of tree) walk(item, visit);
    return;
  }
  if (!tree || typeof tree !== "object") return;
  for (const [key, value] of Object.entries(tree)) {
    if (/^[A-Z]/.test(key) && value && typeof value === "object" && !Array.isArray(value)) visit(key, value as Node);
    walk(value, visit);
  }
}

function some(tree: unknown, test: (type: string, body: Node) => boolean): boolean {
  let found = false;
  walk(tree, (type, body) => {
    if (!found && test(type, body)) found = true;
  });
  return found;
}

/** The leftmost position in a tree (bytes into the script), or null. */
export function firstLocation(tree: unknown): number | null {
  let best: number | null = null;
  const look = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) look(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (key === "location" && typeof v === "number" && v >= 0) best = best === null ? v : Math.min(best, v);
      else look(v);
    }
  };
  look(tree);
  return best;
}

const AGGREGATES = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "array_agg",
  "string_agg",
  "bool_and",
  "bool_or",
  "every",
  "json_agg",
  "jsonb_agg",
  "json_object_agg",
  "jsonb_object_agg",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "variance",
  "var_pop",
  "var_samp",
  "mode",
  "percentile_cont",
  "percentile_disc",
  "bit_and",
  "bit_or",
  "bit_xor",
  "corr",
  "covar_pop",
  "covar_samp",
  "regr_slope",
  "regr_intercept",
  "xmlagg",
  "range_agg",
  "range_intersect_agg",
]);

/** Functions that give a new answer each time: each step's query would see different values. */
const VOLATILE = new Set([
  "random",
  "random_normal",
  "clock_timestamp",
  "timeofday",
  "gen_random_uuid",
  "uuidv4",
  "uuidv7",
  "nextval",
  "setval",
  "setseed",
]);

const funcName = (call: Node): string => {
  const parts: Node[] = call.funcname ?? [];
  return String(parts[parts.length - 1]?.String?.sval ?? "").toLowerCase();
};

/**
 * What this SELECT uses that isn't stepped through yet, in words ("joins"),
 * or null if it can be.
 */
export function unsupported(select: Node): string | null {
  if (select.withClause) return "WITH (common table expressions)";
  if (select.op && select.op !== "SETOP_NONE") return "UNION, INTERSECT and EXCEPT";
  if (select.valuesLists) return "VALUES lists";
  if (select.lockingClause) return "FOR UPDATE and other locking clauses";
  if (select.groupClause) return "GROUP BY";
  if (select.havingClause) return "HAVING";
  if (select.windowClause) return "window functions";
  if (some(select, (type, body) => type === "FuncCall" && !!body.over)) return "window functions";
  if (
    some(
      select,
      (type, body) =>
        type === "FuncCall" &&
        (AGGREGATES.has(funcName(body)) || !!body.agg_star || !!body.agg_distinct || !!body.agg_within_group),
    )
  )
    return "aggregate functions like COUNT and SUM";
  if (some(select, (type) => type === "SubLink")) return "subqueries";
  if (select.distinctClause?.some((item: Node) => Object.keys(item).length > 0)) return "DISTINCT ON";
  if (select.limitOption === "LIMIT_OPTION_WITH_TIES") return "FETCH … WITH TIES";
  if (select.fromClause) {
    const shape = readFrom(select.fromClause);
    if (typeof shape === "string") return shape;
  }
  if (some(select, (type, body) => type === "FuncCall" && VOLATILE.has(funcName(body))))
    return "functions like random() that give a new answer each time";
  return null;
}

/** The parts of a WHERE condition worth a column each: what AND, OR and NOT join (up to four). */
function conditionParts(where: Node): Node[] {
  if (!where.BoolExpr) return [];
  const parts: Node[] = [];
  const visit = (node: Node) => {
    if (node.BoolExpr) for (const arg of node.BoolExpr.args ?? []) visit(arg);
    else parts.push(node);
  };
  visit(where);
  return parts.length >= 2 && parts.length <= 4 ? parts : [];
}

/** One table joined to the rows before it. */
interface JoinPart {
  /** "JOIN", "LEFT JOIN"... "CROSS JOIN" (also for a comma in FROM). */
  type: string;
  range: Node;
  /** The JoinExpr (null for a comma), for the FROM so far and the condition. */
  join: Node | null;
}

/** FROM as its first table and the tables joined to it in order, or what isn't stepped through yet. */
export function readFrom(from: Node[]): { first: Node; joins: JoinPart[] } | string {
  const other = (item: Node): string => {
    if (item.RangeSubselect) return "subqueries in FROM";
    if (item.RangeFunction) return "functions in FROM, like generate_series";
    return "this kind of FROM";
  };
  if (from.length > 1) {
    // A comma between tables: every row with every row, as CROSS JOIN.
    if (from.some((item) => item.JoinExpr)) return "a mix of commas and JOIN in FROM";
    const bad = from.find((item) => !item.RangeVar);
    if (bad) return other(bad);
    return {
      first: from[0].RangeVar,
      joins: from.slice(1).map((item) => ({ type: "CROSS JOIN", range: item.RangeVar, join: null })),
    };
  }
  const joins: JoinPart[] = [];
  let node: Node = from[0];
  while (node.JoinExpr) {
    const j: Node = node.JoinExpr;
    if (j.alias || j.join_using_alias) return "a join with a name of its own (AS after the join)";
    if (!j.rarg?.RangeVar) return j.rarg?.JoinExpr ? "joins in parentheses" : other(j.rarg ?? {});
    const kind: Record<string, string> = {
      JOIN_INNER: "JOIN",
      JOIN_LEFT: "LEFT JOIN",
      JOIN_RIGHT: "RIGHT JOIN",
      JOIN_FULL: "FULL JOIN",
    };
    const word = kind[j.jointype];
    if (!word) return "this kind of join";
    const cross = word === "JOIN" && !j.quals && !j.usingClause && !j.isNatural;
    joins.unshift({
      type: `${j.isNatural ? "NATURAL " : ""}${cross ? "CROSS JOIN" : word}`,
      range: j.rarg.RangeVar,
      join: j,
    });
    node = j.larg ?? {};
  }
  if (!node.RangeVar) return other(node);
  return { first: node.RangeVar, joins };
}

// ---------------------------------------------------------------- building tables

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

const toColumn = (c: ResultColumn): SqlColumn => ({
  name: c.name,
  type: c.type,
  ...(c.numeric ? { numeric: true } : {}),
});

const boolText = (value: string | null): string | null => (value === "t" ? "true" : value === "f" ? "false" : value);

/** A table to draw: at most MAX_ROWS rows, the rest counted. */
export function drawnTable(table: Omit<SqlTable, "more">): SqlTable {
  if (table.rows.length <= MAX_ROWS) return table;
  return { ...table, rows: table.rows.slice(0, MAX_ROWS), more: table.rows.length - MAX_ROWS };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Two lists of rows hold the same values: in the same order, or in any order. */
function sameRows(a: (string | null)[][], b: (string | null)[][], ordered: boolean): boolean {
  if (a.length !== b.length) return false;
  const keys = (rows: (string | null)[][]) => rows.map((r) => JSON.stringify(r));
  const [x, y] = [keys(a), keys(b)];
  if (!ordered) {
    x.sort();
    y.sort();
  }
  return x.every((k, i) => k === y[i]);
}

/** A row on its way through the query: its id and label from FROM, its values now. */
interface Flow {
  id: string;
  label: string;
  values: (string | null)[];
}

/** A table in FROM: its name in the query, its id for a row, and its rows. */
interface Source {
  tableName: string;
  alias?: string;
  /** How the query names it: the alias, or the table's name. */
  ref: string;
  refSql: string;
  /** SQL for a row's id in this table. */
  idPart: string;
  range: Node;
  sql: string;
  columns: SqlColumn[];
  rows: Flow[];
}

/** Lines between joined rows drawn at most: more is a tangle, not a picture. */
const MAX_LINKS = 150;

// ---------------------------------------------------------------- the steps

/**
 * The steps of a SELECT `unsupported` accepts, given its own result (run
 * first, so its errors are the query's own). Null if the steps don't add
 * up to that result: show the result instead.
 */
export async function selectStages(ctx: SelectContext, select: Node, result: QueryResult): Promise<SqlStage[] | null> {
  const { engine, parser, statement } = ctx;
  const stage = (s: Omit<SqlStage, "statement">): SqlStage => ({ statement, ...s });
  const targets: Node[] = select.targetList ?? [];
  const targetSql = (await Promise.all(targets.map((t) => parser.deparse(t)))).join(", ");
  const at = (tree: unknown) => {
    const loc = firstLocation(tree);
    return loc === null ? ctx.line : ctx.lineOf(loc);
  };

  // No FROM (SELECT 1 + 1): one step, the result.
  const shape = select.fromClause ? readFrom(select.fromClause) : null;
  if (!shape || typeof shape === "string") {
    const rows = result.rows.map((values, i) => ({ id: `result:${i}`, label: `#${i + 1}`, values }));
    return [
      stage({
        kind: "select",
        clause: `SELECT ${oneLine(targetSql)}`,
        summary: `${plural(rows.length, "row")}`,
        line: at(targets),
        tables: [
          drawnTable({
            name: "result",
            columns: await computedColumns(result.columns, targets, () => 0, parser),
            rows,
          }),
        ],
        rows: rows.length,
      }),
    ];
  }

  // The tables, each with its own rows. A row's id is where Postgres keeps
  // it (ctid), after its table's name, or with several tables its name in
  // the query (two copies of a table in a self join are told apart); a
  // joined row's id is its rows' ids together ("e:0,3|d:0,1", "-" for the
  // NULLs of a row a join didn't match).
  const ranges = [shape.first, ...shape.joins.map((j) => j.range)];
  const several = ranges.length > 1;
  const sources: Source[] = [];
  for (const range of ranges) {
    const tableName = range.schemaname ? `${range.schemaname}.${range.relname}` : String(range.relname);
    const alias: string | undefined = range.alias?.aliasname;
    const ref = String(alias ?? range.relname);
    const source: Source = {
      tableName,
      alias,
      ref,
      refSql: quote(ref),
      idPart: "",
      range,
      sql: await parser.deparse({ RangeVar: range }),
      columns: [],
      rows: [],
    };
    const prefix = (several ? ref : tableName).replace(/'/g, "''");
    source.idPart = `'${prefix}:' || coalesce(translate(${source.refSql}.ctid::text, '()', ''), '-')`;
    const base = await engine.query(
      `SELECT ${source.refSql}.*, ${source.idPart} FROM ${source.sql} ORDER BY ${source.refSql}.ctid`,
    );
    source.columns = base.columns.slice(0, -1).map(toColumn);
    source.rows = base.rows.map((row, i) => ({
      id: String(row[row.length - 1]),
      label: `#${i + 1}`,
      values: row.slice(0, -1),
    }));
    sources.push(source);
  }
  if (new Set(sources.map((s) => s.ref)).size !== sources.length) return null;
  const labels = new Map(sources.flatMap((s) => s.rows.map((r): [string, string] => [r.id, r.label])));
  const labelOf = (id: string) =>
    id
      .split("|")
      .map((part) => (part.endsWith(":-") ? "–" : (labels.get(part) ?? "?")))
      .join("·");
  const idSqlOf = (list: Source[]) => list.map((s) => s.idPart).join(` || '|' || `);
  const orderOf = (list: Source[]) => list.map((s) => `${s.refSql}.ctid NULLS LAST`).join(", ");
  const columnsOf = (list: Source[]): SqlColumn[] =>
    several ? list.flatMap((s) => s.columns.map((c) => ({ ...c, name: `${s.ref}.${c.name}` }))) : list[0].columns;
  const fromSql = (await Promise.all(select.fromClause.map((item: Node) => parser.deparse(item)))).join(", ");
  const idSql = idSqlOf(sources);
  const orderSql = orderOf(sources);
  const idOf = (row: (string | null)[]) => String(row[row.length - 1]);
  const stages: SqlStage[] = [];

  // FROM: every row of the first table, in the order Postgres keeps them.
  const first = sources[0];
  const tableOf = (s: Source, rows: SqlRow[]) =>
    drawnTable({ name: s.tableName, ...(s.alias ? { alias: s.alias } : {}), columns: s.columns, rows });
  stages.push(
    stage({
      kind: "from",
      clause: `FROM ${oneLine(first.sql)}`,
      summary: `${first.tableName}: ${plural(first.rows.length, "row")}`,
      line: at(first.range),
      tables: [tableOf(first, first.rows)],
      rows: first.rows.length,
    }),
  );

  // JOIN: each table joined to the rows so far.
  let current: Flow[] = first.rows;
  let currentColumns = columnsOf([first]);
  let currentName = first.tableName;
  for (const [i, part] of shape.joins.entries()) {
    const joined = sources.slice(0, i + 2);
    const right = sources[i + 1];
    const soFar = part.join
      ? await parser.deparse({ JoinExpr: joinAt(select.fromClause[0], shape.joins.length - 1 - i) })
      : joined.map((s) => s.sql).join(", ");
    const out = await engine.query(
      `SELECT ${joined.map((s) => `${s.refSql}.*`).join(", ")}, ${idSqlOf(joined)} FROM ${soFar} ORDER BY ${orderOf(joined)}`,
    );
    const rows: Flow[] = out.rows.map((row) => {
      const id = idOf(row);
      return { id, label: labelOf(id), values: row.slice(0, -1) };
    });
    const isNull = (id: string) => id.split("|").every((p) => p.endsWith(":-"));
    const links: { from: string; to: string }[] = [];
    const leftMatched = new Set<string>();
    const rightMatched = new Set<string>();
    const resultRows: SqlRow[] = rows.map((r) => {
      const parts = r.id.split("|");
      const leftId = parts.slice(0, -1).join("|");
      const rightId = parts[parts.length - 1];
      if (isNull(leftId) || isNull(rightId)) return { ...r, status: "unmatched", note: "no match: NULLs" };
      links.push({ from: leftId, to: rightId });
      leftMatched.add(leftId);
      rightMatched.add(rightId);
      return r;
    });
    const type = part.type.replace(/^NATURAL /, "");
    const keepsLeft = type === "LEFT JOIN" || type === "FULL JOIN";
    const keepsRight = type === "RIGHT JOIN" || type === "FULL JOIN";
    const mark = (r: Flow, matched: Set<string>, keeps: boolean): SqlRow =>
      matched.has(r.id) || type === "CROSS JOIN"
        ? r
        : keeps
          ? { ...r, status: "unmatched", note: "no match: kept, with NULLs" }
          : { ...r, status: "removed", note: "no match" };
    const leftRows = current.map((r) => mark(r, leftMatched, keepsLeft));
    const rightRows = right.rows.map((r) => mark(r, rightMatched, keepsRight));
    const unmatched = (list: SqlRow[]) => list.filter((r) => r.status).length;
    const rightName = right.alias ? `${right.tableName} AS ${right.alias}` : right.tableName;
    let summary: string;
    if (type === "CROSS JOIN") {
      summary = `${current.length} × ${right.rows.length} = ${plural(rows.length, "row")}: every row with every row`;
    } else {
      const extras: string[] = [];
      const [l, r] = [unmatched(leftRows), unmatched(rightRows)];
      const leftName =
        i === 0 ? (first.alias ? `${first.tableName} AS ${first.alias}` : first.tableName) : "the rows so far";
      if (l)
        extras.push(
          `${l} of ${leftName} ${l === 1 ? "matches" : "match"} nothing: ${keepsLeft ? "kept, with NULLs" : "dropped"}`,
        );
      if (r)
        extras.push(
          `${r} of ${rightName} ${r === 1 ? "matches" : "match"} nothing: ${keepsRight ? "kept, with NULLs" : "left out"}`,
        );
      summary = [`${plural(links.length, "matching pair")}, ${plural(rows.length, "row")}`, ...extras].join("; ");
    }
    const condition = part.join?.quals
      ? ` ON ${await parser.deparse(part.join.quals)}`
      : part.join?.usingClause
        ? ` USING (${(part.join.usingClause as Node[]).map((u) => u.String?.sval).join(", ")})`
        : "";
    const notes: string[] = [];
    if (!part.join)
      notes.push(
        "A comma between tables in FROM pairs every row with every row, like CROSS JOIN: WHERE then keeps the pairs that belong together.",
      );
    if (links.length > MAX_LINKS) notes.push(`${links.length} pairs: too many lines to draw.`);
    const columns = columnsOf(joined);
    stages.push(
      stage({
        kind: "join",
        clause: oneLine(`${part.type} ${right.sql}${condition}`),
        summary,
        line: at(part.join?.quals ?? part.range),
        tables: [
          i === 0
            ? tableOf(first, leftRows)
            : drawnTable({ name: currentName, columns: currentColumns, rows: leftRows }),
          tableOf(right, rightRows),
          drawnTable({ name: "joined", columns, rows: resultRows }),
        ],
        rows: rows.length,
        ...(type !== "CROSS JOIN" && links.length <= MAX_LINKS ? { links } : {}),
        ...(notes.length ? { notes } : {}),
      }),
    );
    current = rows;
    currentColumns = columns;
    currentName = "joined";
  }

  // WHERE: the condition for every row, and the parts AND / OR / NOT join.
  let kept = new Set(current.map((r) => r.id));
  let whereSql = "";
  if (select.whereClause) {
    whereSql = await parser.deparse(select.whereClause);
    let parts = conditionParts(select.whereClause);
    const partSql = await Promise.all(parts.map((p) => parser.deparse(p)));
    const run = (exprs: string[]) =>
      engine.query(
        `SELECT ${[...exprs.map((e) => `(${e})`), `(${whereSql})`, idSql].join(", ")} FROM ${fromSql} ORDER BY ${orderSql}`,
      );
    let checked: QueryResult;
    try {
      checked = await run(partSql);
    } catch {
      // A part alone can fail where the whole doesn't (`b <> 0 AND a / b > 1`): just the whole, then.
      parts = [];
      checked = await run([]);
    }
    const byId = new Map(checked.rows.map((row) => [idOf(row), row]));
    const whereText = oneLine(whereSql, 60);
    kept = new Set();
    const rows: SqlRow[] = current.map((r) => {
      const row = byId.get(r.id) ?? [];
      const verdict = row[row.length - 2] ?? null;
      const checks = row.slice(0, parts.length).map(boolText);
      if (verdict === "t") {
        kept.add(r.id);
        return { id: r.id, label: r.label, values: [...r.values, ...checks, "true"] };
      }
      return {
        id: r.id,
        label: r.label,
        values: [...r.values, ...checks, boolText(verdict)],
        status: "removed",
        ...(verdict === null ? { note: "NULL: unknown, so not kept" } : {}),
      };
    });
    const columns: SqlColumn[] = [
      ...currentColumns,
      ...partSql
        .slice(0, parts.length)
        .map((expr): SqlColumn => ({ name: oneLine(expr, 40), type: "boolean", role: "check", expr: oneLine(expr) })),
      { name: "kept?", type: "boolean", role: "result", expr: whereText },
    ];
    const whereTable = several
      ? { name: currentName }
      : { name: first.tableName, ...(first.alias ? { alias: first.alias } : {}) };
    stages.push(
      stage({
        kind: "where",
        clause: `WHERE ${whereText}`,
        summary: `kept ${kept.size} of ${plural(current.length, "row")}`,
        line: at(select.whereClause),
        tables: [drawnTable({ ...whereTable, columns, rows })],
        rows: kept.size,
      }),
    );
  }
  const whereTail = whereSql ? ` WHERE ${whereSql}` : "";

  // SELECT: the columns asked for, for the rows WHERE kept.
  const selected = await engine.query(`SELECT ${targetSql}, ${idSql} FROM ${fromSql}${whereTail} ORDER BY ${orderSql}`);
  const resultColumns = selected.columns.slice(0, -1);
  // How many columns a `*` stands for: every table's, or `t.*` one table's.
  const starWidth = (fields: Node[]) => {
    if (fields.length === 1) return sources.reduce((n, s) => n + s.columns.length, 0);
    const name = fields[0]?.String?.sval;
    return sources.find((s) => s.ref === name || s.tableName === name)?.columns.length ?? 0;
  };
  let columns = await computedColumns(resultColumns, targets, starWidth, parser);
  let rows: Flow[] = selected.rows.map((row) => {
    const id = idOf(row);
    return { id, label: labelOf(id), values: row.slice(0, -1) };
  });
  const computed = columns.filter((c) => c.role === "computed").length;
  stages.push(
    stage({
      kind: "select",
      clause: `SELECT ${oneLine(targetSql, 60)}`,
      summary:
        `${plural(columns.length, "column")}` +
        (computed ? ` (${computed} worked out)` : "") +
        `, ${plural(rows.length, "row")}`,
      line: at(targets),
      tables: [drawnTable({ name: "result", columns, rows })],
      rows: rows.length,
    }),
  );

  // DISTINCT: the first of each set of identical rows stays.
  const distinct = !!select.distinctClause;
  if (distinct) {
    const first = new Map<string, Flow>();
    const shown: SqlRow[] = rows.map((r) => {
      const key = JSON.stringify(r.values);
      const same = first.get(key);
      if (same) return { ...r, status: "removed", note: `same as ${same.label}` };
      first.set(key, r);
      return r;
    });
    const before = rows.length;
    rows = [...first.values()];
    stages.push(
      stage({
        kind: "distinct",
        clause: "SELECT DISTINCT",
        summary: `${plural(rows.length, "different row")} of ${before}`,
        line: ctx.line,
        tables: [drawnTable({ name: "result", columns, rows: shown })],
        rows: rows.length,
      }),
    );
  }

  // ORDER BY: the rows in the query's order, and the values it sorts on.
  let ties = false;
  const sorts: Node[] = (select.sortClause ?? []).map((s: Node) => s.SortBy);
  if (sorts.length) {
    const sortSql = (await Promise.all((select.sortClause as Node[]).map((s) => parser.deparse(s)))).join(", ");
    let order: string[];
    if (distinct) {
      // DISTINCT has no row ids to sort: find each row by its values.
      const ordered = await engine.query(
        `SELECT DISTINCT ${targetSql} FROM ${fromSql}${whereTail} ORDER BY ${sortSql}`,
      );
      const byValues = new Map(rows.map((r) => [JSON.stringify(r.values), r.id]));
      order = ordered.rows.map((values) => byValues.get(JSON.stringify(values)) ?? "");
    } else {
      // The id last, so ORDER BY 2 still means the second column.
      const ordered = await engine.query(
        `SELECT ${targetSql}, ${idSql} FROM ${fromSql}${whereTail} ORDER BY ${sortSql}`,
      );
      order = ordered.rows.map(idOf);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (order.length !== rows.length || order.some((id) => !byId.has(id))) return null;
    rows = order.map((id) => byId.get(id)!);

    // The sort keys: a column of the result, or a value worked out for this step.
    columns = columns.map((c) => ({ ...c }));
    const extra: { column: SqlColumn; values: Map<string, string | null> }[] = [];
    const keyOf: ((r: Flow) => string | null)[] = [];
    for (const [i, sort] of sorts.entries()) {
      const desc = sort.sortby_dir === "SORTBY_DESC";
      const node: Node = sort.node ?? {};
      const fields: Node[] | undefined = node.ColumnRef?.fields;
      let index = -1;
      if (fields?.length === 1 && fields[0].String) index = columns.findIndex((c) => c.name === fields[0].String.sval);
      else if (node.A_Const?.ival) index = Number(node.A_Const.ival.ival ?? 0) - 1;
      if (index >= 0 && index < columns.length) {
        columns[index].sort ??= { rank: i + 1, desc };
        keyOf.push((r) => r.values[index]);
        continue;
      }
      if (distinct) continue;
      const expr = await parser.deparse(node);
      try {
        const keys = await engine.query(`SELECT (${expr}), ${idSql} FROM ${fromSql}${whereTail}`);
        const values = new Map(keys.rows.map((row) => [idOf(row), row[0]]));
        extra.push({
          column: {
            name: oneLine(expr, 40),
            type: keys.columns[0].type,
            role: "sort",
            expr: oneLine(expr),
            sort: { rank: i + 1, desc },
          },
          values,
        });
        keyOf.push((r) => values.get(r.id) ?? null);
      } catch {
        // Not something this step can work out on its own: the order is still right.
      }
    }
    const shown: SqlRow[] = rows.map((r, i) => {
      const row: SqlRow = {
        id: r.id,
        label: r.label,
        values: [...r.values, ...extra.map((e) => e.values.get(r.id) ?? null)],
      };
      if (i > 0 && keyOf.length === sorts.length) {
        const key = (x: Flow) => JSON.stringify(keyOf.map((k) => k(x)));
        if (key(r) === key(rows[i - 1])) {
          row.tie = true;
          ties = true;
        }
      }
      return row;
    });
    const named = sorts.map((sort, i) => {
      const column =
        columns.find((c) => c.sort?.rank === i + 1) ?? extra.find((e) => e.column.sort?.rank === i + 1)?.column;
      const name = column?.name ?? `key ${i + 1}`;
      return sort.sortby_dir === "SORTBY_DESC" ? `${name} (descending)` : name;
    });
    stages.push(
      stage({
        kind: "order",
        clause: `ORDER BY ${oneLine(sortSql, 60)}`,
        summary: `sorted by ${named.join(", then ")}`,
        line: at(select.sortClause),
        tables: [drawnTable({ name: "result", columns: [...columns, ...extra.map((e) => e.column)], rows: shown })],
        rows: rows.length,
        ...(ties
          ? { notes: ["Rows marked = sort the same as the row above: Postgres may give tied rows in either order."] }
          : {}),
      }),
    );
  }

  // LIMIT and OFFSET: the rows before and past the cut are dropped.
  if (select.limitCount || select.limitOffset) {
    const countSql = select.limitCount ? await parser.deparse(select.limitCount) : "NULL";
    const offsetSql = select.limitOffset ? await parser.deparse(select.limitOffset) : "0";
    const cut = await engine.query(`SELECT (${countSql})::bigint::text, (${offsetSql})::bigint::text`);
    const count = cut.rows[0][0] === null ? null : Number(cut.rows[0][0]);
    const offset = Number(cut.rows[0][1] ?? 0);
    const end = count === null ? rows.length : Math.min(rows.length, offset + count);
    const shown: SqlRow[] = rows.map((r, i) =>
      i < offset
        ? { ...r, status: "removed", note: `skipped by OFFSET ${offset}` }
        : i >= end
          ? { ...r, status: "removed", note: `past LIMIT ${count}` }
          : { ...r },
    );
    const cuts: SqlTable["cuts"] = [];
    if (offset > 0 && offset <= rows.length) cuts.push({ before: offset, label: `OFFSET ${offset}` });
    if (count !== null && end < rows.length) cuts.push({ before: end, label: `LIMIT ${count}` });
    const before = rows.length;
    rows = rows.slice(Math.min(offset, rows.length), end);
    const clause = [select.limitCount ? `LIMIT ${countSql}` : "", select.limitOffset ? `OFFSET ${offsetSql}` : ""]
      .filter(Boolean)
      .join(" ");
    stages.push(
      stage({
        kind: "limit",
        clause: oneLine(clause),
        summary: `kept ${rows.length} of ${plural(before, "row")}`,
        line: at([select.limitCount, select.limitOffset]),
        tables: [drawnTable({ name: "result", columns: columns.map(({ sort: _, ...c }) => c), rows: shown, cuts })],
        rows: rows.length,
      }),
    );
  }

  // The steps must end where the query did.
  const ordered = sorts.length > 0 && !ties;
  if (
    !sameRows(
      rows.map((r) => r.values),
      result.rows,
      ordered,
    )
  )
    return null;
  if (!sorts.length && rows.length > 1) {
    const last = stages[stages.length - 1];
    last.notes = [
      ...(last.notes ?? []),
      "No ORDER BY: Postgres may give these rows in any order. Add ORDER BY to choose one.",
    ];
  }
  return stages;
}

/**
 * The result's columns, marking the ones SELECT works out (anything but a
 * plain column name, or `*`), with their expressions. `starWidth`: how many
 * columns a `*` stands for.
 */
async function computedColumns(
  columns: ResultColumn[],
  targets: Node[],
  starWidth: (fields: Node[]) => number,
  parser: SqlParser,
): Promise<SqlColumn[]> {
  const out = columns.map(toColumn);
  const computed: [number, Node][] = [];
  let i = 0;
  for (const target of targets) {
    const val: Node = target.ResTarget?.val ?? {};
    const fields: Node[] | undefined = val.ColumnRef?.fields;
    if (fields?.some((f) => f.A_Star)) {
      i += starWidth(fields);
      continue;
    }
    if (!fields) computed.push([i, val]);
    i++;
  }
  // A `*` that doesn't add up (USING and NATURAL joins merge columns): no way to tell which are which.
  if (i !== out.length) return out;
  for (const [index, val] of computed) {
    out[index].role = "computed";
    out[index].expr = oneLine(await parser.deparse(val));
  }
  return out;
}

/** The JoinExpr `depth` levels down a left-deep join's left side (0: the whole join). */
function joinAt(item: Node, depth: number): Node {
  let node: Node = item.JoinExpr;
  for (let d = 0; d < depth; d++) node = node.larg.JoinExpr;
  return node;
}
