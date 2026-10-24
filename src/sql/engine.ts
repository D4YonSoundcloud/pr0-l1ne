/**
 * Postgres, for the SQL tracer: PGlite (Postgres compiled to WebAssembly)
 * behind the small interface the tracer needs, so the tracer can be tested
 * in Node with the same engine the browser runs.
 *
 * Every value comes back as the text Postgres writes it ("3.50", "t",
 * "2024-01-05"), not converted to JavaScript: that's what's drawn, exactly
 * as Postgres would print it, and two values are the same when their text
 * is.
 */
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";

export interface ResultColumn {
  name: string;
  /** Postgres's name for the type: "integer", "numeric(6,2)", "text". */
  type: string;
  numeric: boolean;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: (string | null)[][];
  /** Rows an INSERT, UPDATE or DELETE changed. */
  affected?: number;
}

/** An error from Postgres, in the parts the tracer explains. */
export class SqlError extends Error {
  constructor(
    message: string,
    /** The SQLSTATE: "42703" is an unknown column. */
    readonly code: string,
    /** Where in the statement (characters, from 1), when Postgres says. */
    readonly position?: number,
    readonly detail?: string,
    readonly hint?: string,
    /** For a broken rule (a key, NOT NULL, CHECK): its table, column and name. */
    readonly where: { table?: string; column?: string; constraint?: string } = {},
  ) {
    super(message);
    this.name = "SqlError";
  }
}

export interface Engine {
  /** Run one statement. Throws a SqlError for anything Postgres refuses. */
  query(sql: string): Promise<QueryResult>;
}

/** The numeric types (by name), drawn right-aligned. */
const NUMERIC = /^(smallint|integer|bigint|numeric|real|double precision|money|oid)\b/;

export class PgliteEngine implements Engine {
  private readonly typeNames = new Map<number, string>();
  /** A parser for each type that keeps Postgres's text (see the top of the file). */
  private raw: Record<number, (text: string) => string> = {};

  private constructor(private readonly db: PGlite) {}

  /** Start Postgres. Takes a few seconds the first time (it sets up a fresh database). */
  static async create(options: PGliteOptions = {}): Promise<PgliteEngine> {
    const engine = new PgliteEngine(await PGlite.create(options));
    await engine.loadTypes();
    return engine;
  }

  /** Postgres's version, for the status bar: "PostgreSQL 18.6". */
  async version(): Promise<string> {
    const { rows } = await this.query("SHOW server_version");
    return `PostgreSQL ${String(rows[0]?.[0] ?? "").split(" ")[0]}`;
  }

  private async loadTypes(oids?: number[]): Promise<void> {
    const where = oids ? `WHERE oid IN (${oids.join(",")})` : "";
    const result = await this.db.query<[number, string]>(
      `SELECT oid::int, format_type(oid, NULL) FROM pg_type ${where}`,
      [],
      { rowMode: "array" },
    );
    for (const [oid, name] of result.rows) {
      this.typeNames.set(Number(oid), name);
      this.raw[Number(oid)] = (text) => text;
    }
  }

  async query(sql: string): Promise<QueryResult> {
    let result: Awaited<ReturnType<PGlite["query"]>>;
    try {
      result = await this.db.query(sql, [], { rowMode: "array", parsers: this.raw });
    } catch (error) {
      throw toSqlError(error);
    }
    // A type made since (CREATE TYPE): learn its name.
    const unknown = result.fields.map((f) => f.dataTypeID).filter((oid) => !this.typeNames.has(oid));
    if (unknown.length) await this.loadTypes([...new Set(unknown)]);
    return {
      columns: result.fields.map((f) => {
        const type = this.typeNames.get(f.dataTypeID) ?? "unknown";
        return { name: f.name, type, numeric: NUMERIC.test(type) };
      }),
      rows: (result.rows as unknown[][]).map((row) => row.map(text)),
      affected: result.affectedRows,
    };
  }
}

/** A value as text: what the raw parsers give, and for safety anything else. */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

/** PGlite's errors carry Postgres's fields; anything else is passed on as it is. */
export function toSqlError(error: unknown): unknown {
  if (!(error instanceof Error) || typeof (error as { code?: unknown }).code !== "string") return error;
  const e = error as Error & {
    code: string;
    position?: string;
    detail?: string;
    hint?: string;
    table?: string;
    column?: string;
    constraint?: string;
  };
  const position = e.position ? Number(e.position) : undefined;
  return new SqlError(e.message, e.code, Number.isFinite(position) ? position : undefined, e.detail, e.hint, {
    table: e.table,
    column: e.column,
    constraint: e.constraint,
  });
}
