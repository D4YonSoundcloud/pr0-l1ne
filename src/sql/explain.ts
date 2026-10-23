/**
 * Postgres's errors, explained: its message (precise, but written for people
 * who already know SQL), then a sentence on what usually causes it and what
 * to try. Keyed by SQLSTATE, the code Postgres gives every error.
 */
import { SAMPLE_DATABASES } from "./databases";
import type { SqlError } from "./engine";

/** What's known about the database when the error happened, to make the explanation specific. */
export interface ErrorContext {
  /** The tables there are. */
  tables: string[];
  /** Columns of the tables the statement uses, by table. */
  columns: Map<string, string[]>;
  /** Names the statement gives columns with AS in its SELECT. */
  aliases: string[];
  /** Did the program ask for a sample database? */
  database: string | null;
}

const list = (items: string[]) => items.map((s) => `"${s}"`).join(", ");

const DATABASES = SAMPLE_DATABASES.map((db) => db.name).join(", ");

/** The quoted name in a message: `column "nme" does not exist` gives nme. */
const quoted = (message: string) => /"([^"]+)"/.exec(message)?.[1] ?? "";

export function explainError(error: SqlError, ctx: ErrorContext): string {
  const parts = [sentence(error.message)];
  if (error.detail) parts.push(sentence(error.detail));
  const why = advice(error, ctx);
  if (why) parts.push(why);
  if (error.hint && !why) parts.push(sentence(error.hint));
  return parts.join(" ");
}

const sentence = (text: string) => {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

function advice(error: SqlError, ctx: ErrorContext): string | null {
  switch (error.code) {
    case "42703": {
      // undefined_column
      const name = quoted(error.message).split(".").pop() ?? "";
      if (ctx.aliases.includes(name))
        return `"${name}" is a name SELECT gives a column, and WHERE runs before SELECT, so it doesn't exist yet there. Repeat the expression instead.`;
      const known = [...ctx.columns.entries()].map(([table, cols]) => `${table} has ${list(cols)}`);
      const hint = error.hint ? ` ${sentence(error.hint)}` : "";
      if (known.length) return `${known.join("; ")}.${hint}`;
      return hint.trim() || null;
    }
    case "42P01": {
      // undefined_table
      if (ctx.tables.length) return `The tables are: ${list(ctx.tables)}.`;
      if (!ctx.database)
        return `There are no tables yet. Start the program with -- viz: database shop to use a sample database (${DATABASES}), or make one with CREATE TABLE.`;
      return null;
    }
    case "42601":
      return "Look just before this point: a missing or extra comma, a quote that isn't closed, or a keyword in the wrong place.";
    case "42702":
      return "More than one table has a column with this name: write table.column to say which.";
    case "42P07":
      return ctx.database
        ? `The ${ctx.database} database already has a table with this name: pick another name, or use the one there is.`
        : "A table with this name was already made earlier in the program.";
    case "22012":
      return "One of the rows divides by zero. NULLIF(x, 0) turns a zero into NULL, and dividing by NULL gives NULL.";
    case "22P02":
      return "A value isn't written the way its type needs: 'abc' isn't a number, for example.";
    case "42883":
      return error.hint
        ? `${sentence(error.hint)} Check the function's name, and the types of what you give it.`
        : null;
    case "42804":
    case "42846":
      return "The two sides aren't the same type: compare numbers with numbers and text with text, or convert one with CAST(x AS type).";
    case "23505":
      return "The column must be unique, and another row already has this value.";
    case "23502":
      return "The column can't be NULL: give it a value.";
    case "23503":
      return "A row here must point at a row that exists in the other table.";
    case "42803":
      return "Every column in SELECT must be inside an aggregate (like COUNT) or listed in GROUP BY.";
    case "57014":
      return "It ran for too long and was stopped.";
    default:
      return null;
  }
}
