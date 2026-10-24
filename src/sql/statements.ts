/**
 * Statements that aren't queries (CREATE TABLE, INSERT, UPDATE, DELETE...):
 * each is one step, showing the table it changed, with the rows it added,
 * changed or removed marked. And the few statements a run can't allow.
 */
import type { SqlRow, SqlStage, SqlTable } from "../trace/types";
import type { Engine, QueryResult, SqlError } from "./engine";
import type { Node, SqlParser } from "./parser";
import { oneLine } from "./script";
import { drawnTable, firstLocation } from "./select";

/** The statement's kind in words: "CREATE TABLE", "INSERT"... */
export function statementKind(stmt: Node): string {
  const type = Object.keys(stmt)[0] ?? "";
  const known: Record<string, string> = {
    SelectStmt: "SELECT",
    InsertStmt: "INSERT",
    UpdateStmt: "UPDATE",
    DeleteStmt: "DELETE",
    CreateStmt: "CREATE TABLE",
    CreateTableAsStmt: "CREATE TABLE AS",
    DropStmt: "DROP",
    AlterTableStmt: "ALTER TABLE",
    IndexStmt: "CREATE INDEX",
    ViewStmt: "CREATE VIEW",
    TruncateStmt: "TRUNCATE",
    VariableSetStmt: "SET",
    VariableShowStmt: "SHOW",
    ExplainStmt: "EXPLAIN",
  };
  if (known[type]) return known[type];
  return type
    .replace(/Stmt$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toUpperCase();
}

/** Why a statement can't run here, or null. */
export function refused(stmt: Node): string | null {
  const type = Object.keys(stmt)[0] ?? "";
  switch (type) {
    case "TransactionStmt":
      return "BEGIN, COMMIT and ROLLBACK aren't needed here: every run starts from a fresh copy of the database, and nothing is kept after it.";
    case "CopyStmt":
      return "COPY can't read or write files here. Use INSERT to add rows.";
    case "CreatedbStmt":
    case "DropdbStmt":
    case "AlterSystemStmt":
    case "VacuumStmt":
    case "CheckPointStmt":
    case "LoadStmt":
    case "CreateTableSpaceStmt":
    case "DropTableSpaceStmt":
    case "ListenStmt":
    case "NotifyStmt":
    case "UnlistenStmt":
      return `${statementKind(stmt)} isn't available here: a run has one database, made fresh each time.`;
    default:
      return null;
  }
}

/** The table a statement changes, as SQL: `"pets"`, or null. */
function target(stmt: Node): { name: string; sql: string } | null {
  const body: Node = Object.values(stmt)[0] ?? {};
  const relation: Node | undefined = body.relation ?? body.into?.rel;
  if (!relation?.relname) return null;
  const quote = (n: string) => `"${String(n).replace(/"/g, '""')}"`;
  const name = relation.schemaname ? `${relation.schemaname}.${relation.relname}` : String(relation.relname);
  return {
    name,
    sql: relation.schemaname ? `${quote(relation.schemaname)}.${quote(relation.relname)}` : quote(relation.relname),
  };
}

/** A table's rows now, by where Postgres keeps them (ctid), or null if it isn't a table now. */
export async function snapshot(
  engine: Engine,
  name: string,
  sql: string,
): Promise<{ table: SqlTable; ids: string[] } | null> {
  let result: QueryResult;
  try {
    result = await engine.query(`SELECT *, ctid::text FROM ${sql} ORDER BY ${sql}.ctid`);
  } catch {
    return null;
  }
  const ids = result.rows.map((row) => `${name}:${String(row[row.length - 1]).replace(/[()]/g, "")}`);
  return {
    ids,
    table: {
      name,
      columns: result.columns
        .slice(0, -1)
        .map((c) => ({ name: c.name, type: c.type, ...(c.numeric ? { numeric: true } : {}) })),
      rows: result.rows.map((row, i) => ({ id: ids[i], label: `#${i + 1}`, values: row.slice(0, -1) })),
    },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What runStatement needs besides the engine: the parser, and where the statement is. */
export interface StatementContext {
  engine: Engine;
  parser: SqlParser;
  /** The line of a byte offset in the script. */
  lineOf(byteOffset: number): number;
}

/** The differences between an old row and its new version: "age 3 → 4". */
function differences(columns: SqlTable["columns"], before: SqlRow, after: SqlRow): string {
  const changed = columns
    .map((c, i) =>
      before.values[i] === after.values[i]
        ? null
        : `${c.name} ${before.values[i] ?? "NULL"} → ${after.values[i] ?? "NULL"}`,
    )
    .filter((d): d is string => d !== null);
  return changed.length > 2 ? `${changed.slice(0, 2).join(", ")}, …` : changed.join(", ") || "no change";
}

/**
 * Run a statement that isn't a query. CREATE TABLE, INSERT and the rest
 * are one step: the table it changed, before and after, the rows it
 * added, changed or removed marked. An UPDATE or DELETE with a WHERE first
 * steps through its WHERE: which rows it picks.
 */
export async function runStatement(
  ctx: StatementContext,
  stmt: Node,
  text: string,
  base: Omit<SqlStage, "kind" | "summary" | "tables">,
): Promise<{ stages: SqlStage[]; result: QueryResult }> {
  const { engine, parser } = ctx;
  const table = target(stmt);
  const type = Object.keys(stmt)[0];
  const body: Node = stmt[type] ?? {};
  const before = table ? await snapshot(engine, table.name, table.sql) : null;
  const stages: SqlStage[] = [];

  // UPDATE and DELETE: the rows WHERE picks, before anything changes.
  const picked = new Set<string>();
  const updating = type === "UpdateStmt";
  if (
    (updating || type === "DeleteStmt") &&
    before &&
    table &&
    body.whereClause &&
    !body.fromClause &&
    !body.usingClause
  ) {
    const whereSql = await parser.deparse(body.whereClause);
    const verdicts = await engine.query(
      `SELECT (${whereSql}), translate(ctid::text, '()', '') FROM ${table.sql} ORDER BY ctid`,
    );
    const verdict = new Map(verdicts.rows.map((r) => [`${table.name}:${r[1]}`, r[0]]));
    const rows = before.table.rows.map((r): SqlRow => {
      const v = verdict.get(r.id) ?? null;
      const values = [...r.values, v === "t" ? "true" : v === "f" ? "false" : null];
      if (v === "t") {
        picked.add(r.id);
        return {
          ...r,
          values,
          status: updating ? "changed" : "removed",
          note: updating ? "picked: to change" : "picked: to delete",
        };
      }
      return { ...r, values, ...(v === null ? { note: "NULL: unknown, so not picked" } : {}) };
    });
    const loc = firstLocation(body.whereClause);
    stages.push({
      ...base,
      kind: "where",
      clause: `WHERE ${oneLine(whereSql, 60)}`,
      summary: `picks ${picked.size} of ${plural(rows.length, "row")} to ${updating ? "change" : "delete"}`,
      ...(loc === null ? {} : { line: ctx.lineOf(loc) }),
      tables: [
        drawnTable({
          ...before.table,
          columns: [
            ...before.table.columns,
            { name: "picked?", type: "boolean", role: "result", expr: oneLine(whereSql) },
          ],
          rows,
        }),
      ],
      rows: picked.size,
    });
  }

  const result = await engine.query(text);
  const after = table ? await snapshot(engine, table.name, table.sql) : null;
  const changed = result.affected ?? 0;
  let tables: SqlTable[] = [];
  let summary = "done";
  // The table before, beside it after: its rows are kept apart by id.
  const beforeTable = (rows: SqlRow[]) =>
    drawnTable({
      ...before!.table,
      name: `${before!.table.name} (before)`,
      rows: rows.map((r) => ({ ...r, id: `before|${r.id}` })),
    });

  if (type === "DeleteStmt" && before) {
    const left = new Set(after?.ids ?? []);
    const rows = before.table.rows.map(
      (r): SqlRow => (left.has(r.id) ? r : { ...r, status: "removed", note: "deleted" }),
    );
    tables = after
      ? [beforeTable(rows), drawnTable({ ...after.table, name: `${after.table.name} (after)` })]
      : [drawnTable({ ...before.table, rows })];
    summary = `removed ${plural(changed, "row")}`;
  } else if (after) {
    const old = new Set(before?.ids ?? []);
    const fresh = after.table.rows.filter((r) => !old.has(r.id));
    let rows: SqlRow[];
    if (type === "UpdateStmt" && before) {
      // Postgres writes a changed row anew: its new version pairs with the
      // old one it replaced, in the order both were found.
      const gone = before.table.rows.filter((r) => !new Set(after.ids).has(r.id));
      const pairs = new Map(fresh.map((r, i) => [r.id, gone[i]]));
      rows = after.table.rows.map((r): SqlRow => {
        const was = pairs.get(r.id);
        if (!old.has(r.id) && was)
          return { ...r, status: "changed", note: `was ${was.label}: ${differences(after.table.columns, was, r)}` };
        return r;
      });
      tables = [
        beforeTable(
          before.table.rows.map((r) => (gone.includes(r) ? { ...r, status: "changed", note: "changed" } : r)),
        ),
        drawnTable({ ...after.table, name: `${after.table.name} (after)`, rows }),
      ];
    } else {
      const mark = type === "InsertStmt" ? "added" : null;
      rows = after.table.rows.map((r): SqlRow => (mark && !old.has(r.id) ? { ...r, status: mark, note: "new" } : r));
      tables =
        type === "InsertStmt" && before?.table.rows.length
          ? [beforeTable(before.table.rows), drawnTable({ ...after.table, name: `${after.table.name} (after)`, rows })]
          : [drawnTable({ ...after.table, rows })];
    }
    summary =
      type === "InsertStmt"
        ? `added ${plural(changed, "row")}`
        : type === "UpdateStmt"
          ? `changed ${plural(changed, "row")}`
          : type === "CreateStmt" || type === "CreateTableAsStmt"
            ? `made the table ${after.table.name}`
            : `${after.table.name}: ${plural(after.table.rows.length, "row")}`;
  } else if (type === "DropStmt") {
    summary = "dropped";
  }
  stages.push({ ...base, kind: "statement", summary, tables });
  return { stages, result: { ...result, affected: changed } };
}

/**
 * A statement Postgres refused for one of a table's rules (a unique key, a
 * foreign key, NOT NULL, CHECK): a step showing the rows involved, or null
 * if the error isn't one of those. Nothing changed: the tables are as they
 * were before it.
 */
export async function refusedStage(
  engine: Engine,
  error: SqlError,
  base: Omit<SqlStage, "kind" | "summary" | "tables">,
): Promise<SqlStage | null> {
  const { table, column, constraint } = error.where;
  if (!error.code.startsWith("23") || !table) return null;
  const rule = constraint
    ? String(
        (
          await engine
            .query(
              `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '${constraint.replace(/'/g, "''")}'`,
            )
            .catch(() => ({ rows: [[null]] }))
        ).rows[0]?.[0] ?? "",
      )
    : "";
  const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;
  const show = async (name: string, mark: (columns: SqlTable["columns"], row: SqlRow) => string | null) => {
    const snap = await snapshot(engine, name, quote(name));
    if (!snap) return [];
    const rows = snap.table.rows.map((r): SqlRow => {
      const why = mark(snap.table.columns, r);
      return why ? { ...r, status: "changed", note: why } : r;
    });
    return [drawnTable({ ...snap.table, rows })];
  };
  // "Key (a, b)=(1, x)": the columns and their values.
  const key = /Key \((.+?)\)=\((.*)\)/.exec(error.detail ?? "");
  const keyColumns = key ? key[1].split(", ") : [];
  const keyValues = key ? key[2].split(", ") : [];
  const matches = (columns: SqlTable["columns"], row: SqlRow, names: string[]) =>
    names.length > 0 &&
    names.every((n, i) => {
      const at = columns.findIndex((c) => c.name === n);
      return at >= 0 && row.values[at] === keyValues[i];
    });
  let tables: SqlTable[] = [];
  let summary: string;
  switch (error.code) {
    case "23505": // unique_violation
      tables = await show(table, (cols, r) => (matches(cols, r, keyColumns) ? "already has this key" : null));
      summary = `${table} already has a row with ${keyColumns.join(", ")} = ${keyValues.join(", ")}`;
      break;
    case "23503": {
      // foreign_key_violation: a key that isn't there, or a row others still point at.
      const missing = /is not present in table "(.+?)"/.exec(error.detail ?? "");
      if (missing) {
        tables = await show(missing[1], () => null);
        summary = `${missing[1]} has no row with ${keyColumns.join(", ")} = ${keyValues.join(", ")}`;
      } else {
        const pointing = /FOREIGN KEY \((.+?)\)/.exec(rule)?.[1].split(", ") ?? [];
        tables = await show(table, (cols, r) => (matches(cols, r, pointing) ? "still points at it" : null));
        summary = `rows of ${table} still point at ${keyColumns.join(", ")} = ${keyValues.join(", ")}`;
      }
      break;
    }
    case "23502": // not_null_violation
      tables = await show(table, () => null);
      summary = `${column ?? "a column"} of ${table} can't be NULL`;
      break;
    case "23514": // check_violation
      tables = await show(table, () => null);
      summary = `a row of ${table} would break its rule ${rule}`;
      break;
    default:
      return null;
  }
  return {
    ...base,
    kind: "refused",
    summary,
    tables,
    notes: [`Refused: nothing changed.${rule ? ` The rule: ${rule}.` : ""}`],
  };
}
