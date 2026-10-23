/**
 * Statements that aren't queries (CREATE TABLE, INSERT, UPDATE, DELETE...):
 * each is one step, showing the table it changed, with the rows it added,
 * changed or removed marked. And the few statements a run can't allow.
 */
import type { SqlRow, SqlStage, SqlTable } from "../trace/types";
import type { Engine, QueryResult } from "./engine";
import type { Node } from "./parser";
import { drawnTable } from "./select";

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

/**
 * Run a statement that isn't a query, as one step: the table it changed
 * after it ran (for DELETE, before: the removed rows are marked).
 */
export async function runStatement(
  engine: Engine,
  stmt: Node,
  text: string,
  base: Omit<SqlStage, "kind" | "summary" | "tables">,
): Promise<{ stage: SqlStage; result: QueryResult }> {
  const table = target(stmt);
  const before = table ? await snapshot(engine, table.name, table.sql) : null;
  const result = await engine.query(text);
  const after = table ? await snapshot(engine, table.name, table.sql) : null;
  const changed = result.affected ?? 0;
  let tables: SqlTable[] = [];
  let summary = "done";
  const type = Object.keys(stmt)[0];

  if (type === "DeleteStmt" && before) {
    const left = new Set(after?.ids ?? []);
    const rows = before.table.rows.map(
      (r): SqlRow => (left.has(r.id) ? r : { ...r, status: "removed", note: "deleted" }),
    );
    tables = [drawnTable({ ...before.table, rows })];
    summary = `removed ${plural(changed, "row")}`;
  } else if (after) {
    const old = new Set(before?.ids ?? []);
    const mark = type === "InsertStmt" ? "added" : type === "UpdateStmt" ? "changed" : null;
    const rows = after.table.rows.map(
      (r): SqlRow => (mark && !old.has(r.id) ? { ...r, status: mark, note: mark === "added" ? "new" : "updated" } : r),
    );
    tables = [drawnTable({ ...after.table, rows })];
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
  return { stage: { ...base, kind: "statement", summary, tables }, result: { ...result, affected: changed } };
}
