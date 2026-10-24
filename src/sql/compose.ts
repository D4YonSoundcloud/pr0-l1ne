/**
 * Queries made of queries: WITH, subqueries in FROM, and UNION, INTERSECT
 * and EXCEPT. Each inner query is stepped through first, as a part of the
 * statement of its own (`SqlStage.part`), then the rest.
 *
 *   WITH name AS (...)       the WITH query's steps, then the main query's,
 *                            in which `name` is a table
 *   FROM (...) AS name       the subquery's steps, then the query's
 *   a UNION b                a's steps, b's steps, then a step showing the
 *                            two sets of rows and the rows they make
 *                            together; then ORDER BY and LIMIT, if any
 *
 * The rest of the query is then stepped through like any query on tables
 * (select.ts): each WITH query and FROM subquery is made into a temporary
 * table of its rows, under its name, and the query reads that. Rows of a
 * temporary table have a place (ctid) of their own, which select.ts follows
 * them by. The temporary tables are dropped after the statement (trace.ts).
 *
 * Subqueries in SELECT, WHERE and HAVING are select.ts's: it calls back
 * here (`inner`) for one that stands alone.
 */
import type { SqlRow, SqlStage, SqlTable } from "../trace/types";
import type { QueryResult } from "./engine";
import type { Node } from "./parser";
import { oneLine } from "./script";
import { drawnTable, type SelectContext, sameRows, selectStages } from "./select";

export interface ComposeContext extends Omit<SelectContext, "inner"> {
  /** Temporary tables made for this statement, to drop after it. */
  temps: string[];
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const toColumns = (result: QueryResult) =>
  result.columns.map((c) => ({ name: c.name, type: c.type, ...(c.numeric ? { numeric: true } : {}) }));

/** The same context, for a query nested one level deeper, under `label`. */
function deeper(ctx: ComposeContext, label: string): ComposeContext {
  // Named with the parts it's inside: "UNION: the first query › Subquery 1".
  const path = ctx.part ? `${ctx.part.label} › ${label}` : label;
  return { ...ctx, part: { label: path, depth: (ctx.part?.depth ?? 0) + 1 } };
}

/**
 * The steps of any query the stepper accepts (select.ts, unsupported()),
 * given its result. Null if its steps don't add up to the result.
 */
export async function queryStages(
  ctx: ComposeContext,
  select: Node,
  result: QueryResult | null,
  problem?: string,
): Promise<SqlStage[] | null> {
  if (select.withClause) return withStages(ctx, select, result, problem);
  if (select.op && select.op !== "SETOP_NONE") return result ? setOpStages(ctx, select, result) : null;

  // Subqueries in FROM: each stepped through, then made a table under its name.
  const before: SqlStage[] = [];
  let query = select;
  if (select.fromClause && JSON.stringify(select.fromClause).includes('"RangeSubselect"')) {
    const from: Node[] = structuredClone(select.fromClause);
    const replace = async (holder: Node, key: string): Promise<void> => {
      const item: Node = holder[key];
      if (item?.JoinExpr) {
        await replace(item.JoinExpr, "larg");
        await replace(item.JoinExpr, "rarg");
        return;
      }
      const sub: Node | undefined = item?.RangeSubselect;
      if (!sub) return;
      const name = String(sub.alias.aliasname);
      const inner: Node = sub.subquery.SelectStmt;
      const columns: string[] = (sub.alias.colnames ?? []).map((c: Node) => String(c.String?.sval));
      before.push(...(await partStages(deeper(ctx, `Subquery AS ${name}`), inner)).stages);
      await makeTable(ctx, name, columns, inner);
      holder[key] = { RangeVar: { relname: name, inh: true, relpersistence: "p" } };
    };
    for (let i = 0; i < from.length; i++) await replace(from, String(i));
    query = { ...select, fromClause: from };
  }
  const rest = await selectStages(
    { ...ctx, inner: (q, label) => partStages(deeper(ctx, label), q) },
    query,
    result,
    problem,
  );
  return rest ? [...before, ...rest] : null;
}

/** A query of the statement made into a temporary table, under its name. */
async function makeTable(ctx: ComposeContext, name: string, columns: string[], query: Node): Promise<void> {
  const sql = await ctx.parser.deparse({ SelectStmt: query });
  const names = columns.length ? ` (${columns.map(quote).join(", ")})` : "";
  await ctx.engine.query(`CREATE TEMP TABLE ${quote(name)}${names} AS ${sql}`);
  ctx.temps.push(name);
}

/**
 * A part of the statement (a WITH query, a subquery, a UNION's side): its
 * steps, or if it can't be stepped through, its result as one step.
 */
async function partStages(ctx: ComposeContext, select: Node): Promise<{ stages: SqlStage[]; result: QueryResult }> {
  const sql = await ctx.parser.deparse({ SelectStmt: select });
  const result = await ctx.engine.query(sql);
  const stages = await queryStages(ctx, select, result).catch(() => null);
  if (stages?.length) return { stages, result };
  return {
    result,
    stages: [
      {
        statement: ctx.statement,
        ...(ctx.part ? { part: ctx.part } : {}),
        kind: "result",
        clause: oneLine(sql, 60),
        summary: plural(result.rows.length, "row"),
        line: ctx.line,
        tables: [
          drawnTable({
            name: ctx.part?.label ?? "result",
            columns: toColumns(result),
            rows: result.rows.map((values, i) => ({ id: `${ctx.part?.label}:${i}`, label: `#${i + 1}`, values })),
          }),
        ],
        rows: result.rows.length,
        notes: ["PR0L1NE couldn't step through this part, so this is its result."],
      },
    ],
  };
}

/** WITH: each query stepped through, then made a table under its name, then the main query. */
async function withStages(
  ctx: ComposeContext,
  select: Node,
  result: QueryResult | null,
  problem?: string,
): Promise<SqlStage[] | null> {
  const stages: SqlStage[] = [];
  for (const item of select.withClause.ctes as Node[]) {
    const cte: Node = item.CommonTableExpr;
    const name = String(cte.ctename);
    const inner: Node = cte.ctequery.SelectStmt;
    stages.push(...(await partStages(deeper(ctx, `WITH ${name}`), inner)).stages);
    const columns: string[] = (cte.aliascolnames ?? []).map((c: Node) => String(c.String?.sval));
    await makeTable(ctx, name, columns, inner);
  }
  const { withClause: _, ...main } = select;
  const rest = await queryStages(ctx, main, result, problem);
  return rest ? [...stages, ...rest] : null;
}

/** The rows a part's steps end with: its last step's rows that weren't dropped, if they're all drawn. */
function lastRows(part: { stages: SqlStage[]; result: QueryResult }, side: string): SqlRow[] {
  const table = part.stages.at(-1)?.tables.at(-1);
  const rows = table?.rows.filter((r) => r.status !== "removed") ?? [];
  // Both sides can read the same table: their ids are kept apart by side.
  if (table && !table.more && rows.length === part.result.rows.length)
    return rows.map((r) => ({ id: `${side}|${r.id}`, label: r.label, values: r.values }));
  return part.result.rows.map((values, i) => ({ id: `${side}|${i}`, label: `#${i + 1}`, values }));
}

const OPS: Record<string, string> = { SETOP_UNION: "UNION", SETOP_INTERSECT: "INTERSECT", SETOP_EXCEPT: "EXCEPT" };

/**
 * UNION, INTERSECT, EXCEPT: each side stepped through, then the step that
 * puts them together, then (if the statement has them) ORDER BY and LIMIT.
 * Rows are told apart by their values, as the set operations do.
 */
async function setOpStages(ctx: ComposeContext, select: Node, result: QueryResult): Promise<SqlStage[] | null> {
  const op = `${OPS[select.op] ?? "UNION"}${select.all ? " ALL" : ""}`;
  const left = await partStages(deeper(ctx, `${op}: the first query`), select.larg);
  const right = await partStages(deeper(ctx, `${op}: the second query`), select.rarg);
  const a = lastRows(left, "first");
  const b = lastRows(right, "second");
  const key = (r: SqlRow) => JSON.stringify(r.values);
  const count = (rows: SqlRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return m;
  };

  // Which rows the result keeps, and why the others go.
  const all = !!select.all;
  const made: SqlRow[] = [];
  const seen = new Map<string, string>();
  const keepOnce = (r: SqlRow, why: string): SqlRow => {
    const same = seen.get(key(r));
    if (!all && same) return { ...r, status: "removed", note: `same as ${same}` };
    seen.set(key(r), r.label);
    return { ...r, note: why };
  };
  let shownFirst: SqlRow[];
  let shownSecond: SqlRow[] = b;
  if (op.startsWith("UNION")) {
    shownFirst = a.map((r) => keepOnce(r, ""));
    shownSecond = b.map((r) => keepOnce(r, ""));
    made.push(...shownFirst, ...shownSecond.map((r) => ({ ...r, label: `${r.label}′` })));
  } else {
    const inter = op.startsWith("INTERSECT");
    const other = count(b);
    shownFirst = a.map((r): SqlRow => {
      const n = other.get(key(r)) ?? 0;
      if (all) {
        // ALL counts copies: each row of the second query matches (or cancels) one of the first's.
        if (n > 0) other.set(key(r), n - 1);
        if (inter) return n > 0 ? r : { ...r, status: "removed", note: "no copy left in the second query" };
        return n > 0 ? { ...r, status: "removed", note: "cancelled by a copy in the second query" } : r;
      }
      const keeps = inter ? n > 0 : n === 0;
      if (!keeps) return { ...r, status: "removed", note: inter ? "not in the second query" : "in the second query" };
      return keepOnce(r, "");
    });
    made.push(...shownFirst);
  }
  const kept = made.filter((r) => r.status !== "removed");
  const columns = toColumns(left.result);
  const tables: SqlTable[] = [
    drawnTable({ name: "first query", columns, rows: a }),
    drawnTable({
      name: "second query",
      columns: toColumns(right.result),
      rows: shownSecond.map(({ note: _, status: __, ...r }) => r),
    }),
    // The rows made have ids of their own: each row is drawn once a step, and they're drawn beside the rows they came from.
    drawnTable({
      name: op,
      columns,
      rows: made.map(({ note, ...r }) => ({ ...r, id: `made|${r.id}`, ...(note ? { note } : {}) })),
    }),
  ];
  const what: Record<string, string> = {
    UNION: "every row of both, each different row once",
    "UNION ALL": "every row of both, repeats and all",
    INTERSECT: "the rows in both, each once",
    "INTERSECT ALL": "the rows in both, as many times as both have them",
    EXCEPT: "the first query's rows that aren't in the second, each once",
    "EXCEPT ALL": "the first query's rows, less one for each copy in the second",
  };
  const stages: SqlStage[] = [
    ...left.stages,
    ...right.stages,
    {
      statement: ctx.statement,
      ...(ctx.part ? { part: ctx.part } : {}),
      kind: "combine",
      clause: op,
      summary: `${plural(a.length, "row")} and ${plural(b.length, "row")}: ${plural(kept.length, "row")}, ${what[op]}`,
      line: ctx.line,
      tables,
      rows: kept.length,
    },
  ];

  // ORDER BY and LIMIT belong to the whole: step through them on the rows it made.
  if (select.sortClause || select.limitCount || select.limitOffset) {
    const { sortClause, limitCount, limitOffset, ...plain } = select;
    const name = `combined${ctx.temps.length ? `_${ctx.temps.length}` : ""}`;
    await ctx.engine.query(
      `CREATE TEMP TABLE ${quote(name)} AS ${await ctx.parser.deparse({ SelectStmt: { ...plain, limitOption: "LIMIT_OPTION_DEFAULT" } })}`,
    );
    ctx.temps.push(name);
    const [outer] = await ctx.parser.parse(`SELECT * FROM ${quote(name)}`);
    const query = { ...outer.stmt.SelectStmt, sortClause, limitCount, limitOffset, limitOption: select.limitOption };
    const rest = await selectStages(ctx, query, result);
    if (!rest) return null;
    // Its FROM and SELECT * only repeat the rows just made.
    stages.push(...rest.filter((s) => s.kind !== "from" && s.kind !== "select"));
    return stages;
  }
  if (
    !sameRows(
      kept.map((r) => r.values),
      result.rows,
      false,
    )
  )
    return null;
  return stages;
}
