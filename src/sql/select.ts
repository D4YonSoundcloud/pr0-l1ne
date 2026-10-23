/**
 * Stepping through a SELECT: one table per clause, in the order Postgres
 * gives the clauses meaning, not the order they're written:
 *
 *   FROM      the table, every row
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
 * This version steps through queries on one table. Anything else (joins,
 * GROUP BY, subqueries...) is shown as its result, saying what isn't
 * stepped through yet: see unsupported().
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
  const from: Node[] = select.fromClause ?? [];
  if (from.length > 1 || from.some((item) => item.JoinExpr)) return "joins (more than one table in FROM)";
  if (from.some((item) => item.RangeSubselect)) return "subqueries in FROM";
  if (from.some((item) => item.RangeFunction)) return "functions in FROM, like generate_series";
  if (from.some((item) => !item.RangeVar)) return "this kind of FROM";
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
  const range: Node | undefined = select.fromClause?.[0]?.RangeVar;
  if (!range) {
    const rows = result.rows.map((values, i) => ({ id: `result:${i}`, label: `#${i + 1}`, values }));
    return [
      stage({
        kind: "select",
        clause: `SELECT ${oneLine(targetSql)}`,
        summary: `${plural(rows.length, "row")}`,
        line: at(targets),
        tables: [
          drawnTable({ name: "result", columns: await computedColumns(result.columns, targets, 0, parser), rows }),
        ],
        rows: rows.length,
      }),
    ];
  }

  const tableName = range.schemaname ? `${range.schemaname}.${range.relname}` : String(range.relname);
  const alias: string | undefined = range.alias?.aliasname;
  const ref = quote(alias ?? range.relname);
  const fromSql = await parser.deparse({ RangeVar: range });
  const idSql = `${ref}.ctid::text`;
  const stages: SqlStage[] = [];

  // FROM: every row of the table, in the order Postgres keeps them.
  const base = await engine.query(`SELECT ${ref}.*, ${idSql} FROM ${fromSql} ORDER BY ${ref}.ctid`);
  const baseColumns = base.columns.slice(0, -1).map(toColumn);
  const labels = new Map<string, string>();
  const baseRows: Flow[] = base.rows.map((row, i) => {
    const id = `${tableName}:${String(row[row.length - 1]).replace(/[()]/g, "")}`;
    labels.set(id, `#${i + 1}`);
    return { id, label: `#${i + 1}`, values: row.slice(0, -1) };
  });
  const idOf = (row: (string | null)[]) => `${tableName}:${String(row[row.length - 1]).replace(/[()]/g, "")}`;
  stages.push(
    stage({
      kind: "from",
      clause: `FROM ${oneLine(fromSql)}`,
      summary: `${tableName}: ${plural(baseRows.length, "row")}`,
      line: at(range),
      tables: [drawnTable({ name: tableName, ...(alias ? { alias } : {}), columns: baseColumns, rows: baseRows })],
      rows: baseRows.length,
    }),
  );

  // WHERE: the condition for every row, and the parts AND / OR / NOT join.
  let kept = new Set(baseRows.map((r) => r.id));
  let whereSql = "";
  if (select.whereClause) {
    whereSql = await parser.deparse(select.whereClause);
    let parts = conditionParts(select.whereClause);
    const partSql = await Promise.all(parts.map((p) => parser.deparse(p)));
    const run = (exprs: string[]) =>
      engine.query(
        `SELECT ${[...exprs.map((e) => `(${e})`), `(${whereSql})`, idSql].join(", ")} FROM ${fromSql} ORDER BY ${ref}.ctid`,
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
    const rows: SqlRow[] = baseRows.map((r) => {
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
      ...baseColumns,
      ...partSql
        .slice(0, parts.length)
        .map((expr): SqlColumn => ({ name: oneLine(expr, 40), type: "boolean", role: "check", expr: oneLine(expr) })),
      { name: "kept?", type: "boolean", role: "result", expr: whereText },
    ];
    stages.push(
      stage({
        kind: "where",
        clause: `WHERE ${whereText}`,
        summary: `kept ${kept.size} of ${plural(baseRows.length, "row")}`,
        line: at(select.whereClause),
        tables: [drawnTable({ name: tableName, ...(alias ? { alias } : {}), columns, rows })],
        rows: kept.size,
      }),
    );
  }
  const whereTail = whereSql ? ` WHERE ${whereSql}` : "";

  // SELECT: the columns asked for, for the rows WHERE kept.
  const selected = await engine.query(`SELECT ${targetSql}, ${idSql} FROM ${fromSql}${whereTail} ORDER BY ${ref}.ctid`);
  const resultColumns = selected.columns.slice(0, -1);
  let columns = await computedColumns(resultColumns, targets, baseColumns.length, parser);
  let rows: Flow[] = selected.rows.map((row) => {
    const id = idOf(row);
    return { id, label: labels.get(id) ?? "", values: row.slice(0, -1) };
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
  starWidth: number,
  parser: SqlParser,
): Promise<SqlColumn[]> {
  const out = columns.map(toColumn);
  let i = 0;
  for (const target of targets) {
    const val: Node = target.ResTarget?.val ?? {};
    const fields: Node[] | undefined = val.ColumnRef?.fields;
    if (fields?.some((f) => f.A_Star)) {
      i += starWidth;
      continue;
    }
    if (!fields && out[i]) {
      out[i].role = "computed";
      out[i].expr = oneLine(await parser.deparse(val));
    }
    i++;
  }
  return out;
}
