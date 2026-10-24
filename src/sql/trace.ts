/**
 * The SQL tracer: a script run on Postgres (PGlite), statement by statement,
 * made into a trace the app steps through like any other (trace/types.ts:
 * one step per stage, the tables in `Trace.sql`).
 *
 * Each run starts from a fresh database: the sample database the program
 * asks for (`-- viz: database shop`), or none. The whole run is one
 * transaction, rolled back at the end, so nothing a program does (DROP
 * TABLE included) outlives it.
 *
 * Queries (SELECT) are stepped through clause by clause (select.ts); other
 * statements are a step each, showing the table they changed
 * (statements.ts). What Postgres prints goes to the output, as psql shows
 * it. The first error stops the run, explained (explain.ts).
 */
import type { SqlStage, SqlStatement, Step, Trace, TraceError } from "../trace/types";
import { type ComposeContext, queryStages } from "./compose";
import { SAMPLE_DATABASES, sampleDatabase } from "./databases";
import { type Engine, type QueryResult, SqlError } from "./engine";
import { explainError } from "./explain";
import { type Node, ParseError, type SqlParser } from "./parser";
import { oneLine, readHints, SourceText, skipToCode } from "./script";
import { drawnTable, unsupported } from "./select";
import { refused, runStatement, snapshot, statementKind } from "./statements";

/** Rows of a result printed to the output at most. */
const MAX_PRINTED = 200;

/** One step's place in the program: Global, at a line, with nothing in memory (the tables are in Trace.sql). */
function stepAt(line: number, stdoutLength: number): Step {
  return {
    event: "line",
    line,
    stack: [{ id: "f0", func: "Global", line, locals: [] }],
    heap: {},
    stdoutLength,
    loops: [],
  };
}

/** A result as psql prints it: a table, numbers on the right, and how many rows. */
export function formatResult(result: QueryResult): string {
  const rows = result.rows.slice(0, MAX_PRINTED);
  const cells = rows.map((row) => row.map((v) => v ?? ""));
  const widths = result.columns.map((c, i) => Math.max(c.name.length, ...cells.map((row) => row[i].length)));
  const pad = (text: string, i: number, right: boolean) => (right ? text.padStart(widths[i]) : text.padEnd(widths[i]));
  const header = result.columns.map(
    (c, i) => ` ${c.name.padStart(Math.floor((widths[i] + c.name.length) / 2)).padEnd(widths[i])} `,
  );
  const lines = [
    header.join("|").trimEnd(),
    widths.map((w) => "-".repeat(w + 2)).join("+"),
    ...cells.map((row) =>
      row
        .map((v, i) => ` ${pad(v, i, result.columns[i].numeric)} `)
        .join("|")
        .trimEnd(),
    ),
  ];
  if (result.rows.length > rows.length) lines.push(`… ${result.rows.length - rows.length} more`);
  lines.push(`(${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"})`);
  return `${lines.join("\n")}\n`;
}

/** The tables there are now, oldest first. */
async function tableNames(engine: Engine): Promise<string[]> {
  const { rows } = await engine.query(
    "SELECT relname::text FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY oid",
  );
  return rows.map((row) => String(row[0]));
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The engine, with each statement in a savepoint: in a transaction, one
 * failed statement makes Postgres refuse every statement after it, and the
 * tracer carries on after a failure (to explain an error, or to show a
 * query's result when a step's query fails).
 */
function guarded(engine: Engine): Engine {
  return {
    async query(sql: string) {
      await engine.query("SAVEPOINT pr0l1ne");
      try {
        const result = await engine.query(sql);
        await engine.query("RELEASE SAVEPOINT pr0l1ne");
        return result;
      } catch (error) {
        await engine.query("ROLLBACK TO SAVEPOINT pr0l1ne");
        await engine.query("RELEASE SAVEPOINT pr0l1ne");
        throw error;
      }
    },
  };
}

/** Trace a SQL script. */
export async function traceSql(source: string, postgres: Engine, parser: SqlParser): Promise<Trace> {
  const engine = guarded(postgres);
  const text = new SourceText(source);
  const hints = readHints(source);
  const statements: SqlStatement[] = [];
  const stages: SqlStage[] = [];
  const steps: Step[] = [];
  let stdout = "";
  let error: TraceError | null = null;
  const database = hints.database ? sampleDatabase(hints.database.name) : undefined;

  const finish = (): Trace => ({
    version: 1,
    language: "sql",
    steps,
    loops: [],
    indexNames: {},
    stdout,
    error,
    truncated: false,
    // Hints that aren't SQL's own are warned about (trace/hints.ts).
    hints: hints.unknown,
    sql: { ...(database ? { database: database.name } : {}), statements, stages },
  });
  const add = (stage: SqlStage) => {
    stages.push(stage);
    steps.push(stepAt(stage.line, stdout.length));
  };

  if (hints.database && !database) {
    error = {
      type: "Error",
      message: `There's no sample database called "${hints.database.name}". There are: ${SAMPLE_DATABASES.map((db) => `${db.name} (${db.description})`).join(", ")}`,
      line: hints.database.line,
    };
    return finish();
  }

  let parsed: { stmt: Node; start: number; end: number }[];
  try {
    parsed = (await parser.parse(source)).map((s) => {
      const start = s.stmt_location ?? 0;
      return { stmt: s.stmt, start, end: s.stmt_len ? start + s.stmt_len : text.byteLength };
    });
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    const line = e.byteOffset === null ? null : text.lineOf(e.byteOffset);
    error = {
      type: "Error",
      message: `${e.message.replace(/^\w/, (c) => c.toUpperCase())}. Look just before this point: a missing or extra comma, a quote that isn't closed, or a keyword in the wrong place`,
      line,
    };
    return finish();
  }

  await postgres.query("BEGIN");
  try {
    if (database) {
      await runSetup(engine, parser, database.setup);
      const names = await tableNames(engine);
      const tables = [];
      for (const name of names) {
        const snap = await snapshot(engine, name, quote(name));
        if (snap) tables.push(drawnTable(snap.table));
      }
      statements.push({ kind: "DATABASE", line: hints.database!.line, text: `-- viz: database ${database.name}` });
      add({
        kind: "tables",
        clause: `Database ${database.name}`,
        summary: `${names.length} ${names.length === 1 ? "table" : "tables"}: ${names.join(", ")}`,
        statement: 0,
        line: hints.database!.line,
        tables,
      });
    }

    for (const { stmt, start, end } of parsed) {
      const codeStart = skipToCode(source, text.char(start));
      const statementText = text.slice(start, end);
      const line = text.lineOfChar(codeStart);
      const index = statements.length;
      const kind = statementKind(stmt);
      statements.push({ kind, line, text: oneLine(source.slice(codeStart, text.char(end)), 70) });
      const lineAt = (position: number | undefined) =>
        position ? text.lineOfChar(text.char(start) + position - 1) : line;
      /** Temporary tables the steps make (compose.ts), dropped after the statement. */
      const temps: string[] = [];
      try {
        const no = refused(stmt);
        if (no) throw new SqlError(no, "PR0L1");
        if (stmt.SelectStmt && !stmt.SelectStmt.intoClause) {
          const why = unsupported(stmt.SelectStmt);
          const context: ComposeContext = {
            engine,
            parser,
            statement: index,
            line,
            lineOf: (b: number) => text.lineOf(b),
            temps,
          };
          let result: QueryResult;
          try {
            result = await engine.query(statementText);
          } catch (e) {
            // A column that isn't grouped: step through to the groups, to show why.
            const column = e instanceof SqlError && e.code === "42803" ? /column "([^"]+)"/.exec(e.message)?.[1] : null;
            if (column && !why) {
              const expr = column
                .split(".")
                .map((part) => `"${part.replace(/"/g, '""')}"`)
                .join(".");
              const steps = await queryStages(context, stmt.SelectStmt, null, expr).catch(() => null);
              for (const stage of steps ?? []) add(stage);
            }
            throw e;
          }
          let selected: SqlStage[] | null = null;
          if (!why) {
            try {
              selected = await queryStages(context, stmt.SelectStmt, result);
            } catch {
              selected = null;
            }
          }
          if (selected) {
            for (const stage of selected) add(stage);
          } else {
            statements[index].unsupported = why ?? "this query";
            add({
              kind: "result",
              clause: oneLine(source.slice(codeStart, text.char(end)), 60),
              summary: `${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"}`,
              statement: index,
              line,
              tables: [
                drawnTable({
                  name: "result",
                  columns: result.columns.map((c) => ({
                    name: c.name,
                    type: c.type,
                    ...(c.numeric ? { numeric: true } : {}),
                  })),
                  rows: result.rows.map((values, i) => ({ id: `result${index}:${i}`, label: `#${i + 1}`, values })),
                }),
              ],
              rows: result.rows.length,
              notes: [
                why
                  ? `Stepping through ${why} comes in a later version of PR0L1NE: for now, this is the query's result.`
                  : "PR0L1NE couldn't step through this query, so this is its result.",
              ],
            });
          }
          // The query's last step prints its result.
          stdout += `${formatResult(result)}\n`;
          steps[steps.length - 1].stdoutLength = stdout.length;
        } else {
          const { stage, result } = await runStatement(engine, stmt, statementText, {
            clause: oneLine(source.slice(codeStart, text.char(end)), 60),
            statement: index,
            line,
          });
          add(stage);
          stdout += result.columns.length ? `${formatResult(result)}\n` : `${commandTag(stmt, result)}\n`;
          steps[steps.length - 1].stdoutLength = stdout.length;
        }
      } catch (e) {
        if (!(e instanceof SqlError)) throw e;
        error = {
          type: "Error",
          message:
            e.code === "PR0L1" ? e.message : explainError(e, await errorContext(engine, stmt, database?.name ?? null)),
          line: lineAt(e.position),
        };
        break;
      } finally {
        for (const name of temps) await engine.query(`DROP TABLE IF EXISTS pg_temp.${quote(name)}`).catch(() => {});
      }
    }
  } finally {
    await postgres.query("ROLLBACK").catch(() => {});
  }
  return finish();
}

/** psql's line after a statement: "INSERT 0 3", "CREATE TABLE". */
function commandTag(stmt: Node, result: QueryResult): string {
  const kind = statementKind(stmt);
  if (kind === "INSERT") return `INSERT 0 ${result.affected ?? 0}`;
  if (kind === "UPDATE" || kind === "DELETE") return `${kind} ${result.affected ?? 0}`;
  return kind === "DROP" ? "DROP" : kind;
}

/** A sample database's statements, one at a time (a query runs one statement). */
async function runSetup(engine: Engine, parser: SqlParser, setup: string): Promise<void> {
  const text = new SourceText(setup);
  for (const s of await parser.parse(setup)) {
    const start = s.stmt_location ?? 0;
    await engine.query(text.slice(start, s.stmt_len ? start + s.stmt_len : text.byteLength));
  }
}

/** What the explanation of an error can mention: the tables, their columns, the statement's aliases. */
async function errorContext(engine: Engine, stmt: Node, database: string | null) {
  const tables = await tableNames(engine).catch(() => [] as string[]);
  const columns = new Map<string, string[]>();
  const used = new Set<string>();
  const aliases: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    if (node.RangeVar?.relname) used.add(String(node.RangeVar.relname));
    if (node.relation?.relname) used.add(String(node.relation.relname));
    if (node.ResTarget?.name && stmt.SelectStmt) aliases.push(String(node.ResTarget.name));
    for (const v of Object.values(node)) visit(v);
  };
  visit(stmt);
  for (const name of used) {
    if (!tables.includes(name)) continue;
    const { rows } = await engine
      .query(
        `SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${name.replace(/'/g, "''")}' ORDER BY ordinal_position`,
      )
      .catch(() => ({ rows: [] as (string | null)[][] }));
    columns.set(
      name,
      rows.map((r) => String(r[0])),
    );
  }
  return { tables, columns, aliases, database };
}
