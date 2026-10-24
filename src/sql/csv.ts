/**
 * CSV import: a CSV file made into the SQL that makes it a table, CREATE
 * TABLE and INSERT, added to the program. The table is then part of the
 * program's own text, so it's saved with it and travels in its share link,
 * and the file itself never leaves the browser.
 *
 * The first row names the columns. Each column's type is the narrowest
 * that fits every value in it: integer, numeric, date, boolean, or text.
 * An empty value is NULL.
 *
 * No DOM here: the app's side is app/csvImport.ts.
 */

/** Rows imported at most: a program is for reading, and its share link has to hold it. */
export const MAX_CSV_ROWS = 200;

/** Parse CSV (RFC 4180: quoted values may hold commas, quotes as "" and line breaks). Also reads ; and tab separated files. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => firstLine.split(c).length - 1;
  const sep = [",", ";", "\t"].reduce((best, c) => (count(c) > count(best) ? c : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value === "") quoted = true;
    else if (ch === sep) {
      row.push(value);
      value = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += ch;
  }
  if (value !== "" || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** A name SQL can use without quotes: lower case letters, digits and _, not starting with a digit. */
export function sqlName(text: string, fallback: string): string {
  const name = text
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) return fallback;
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** Words SQL itself uses, which can't be a column's name without quotes. */
const RESERVED = new Set([
  "all",
  "and",
  "any",
  "as",
  "asc",
  "case",
  "check",
  "column",
  "create",
  "default",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "false",
  "for",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "into",
  "is",
  "join",
  "limit",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "select",
  "table",
  "then",
  "to",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "when",
  "where",
  "with",
]);

type CsvType = "integer" | "numeric" | "date" | "boolean" | "text";

const TESTS: [CsvType, RegExp][] = [
  ["integer", /^[+-]?\d{1,15}$/],
  ["numeric", /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["boolean", /^(true|false|t|f|yes|no)$/i],
];

/** The narrowest type every (non-empty) value fits. */
function typeOf(values: string[]): CsvType {
  const present = values.map((v) => v.trim()).filter((v) => v !== "");
  if (!present.length) return "text";
  for (const [type, test] of TESTS) if (present.every((v) => test.test(v))) return type;
  return "text";
}

function literal(value: string, type: CsvType): string {
  const v = value.trim();
  if (v === "") return "NULL";
  if (type === "integer" || type === "numeric") return v;
  if (type === "boolean") return /^(true|t|yes)$/i.test(v) ? "true" : "false";
  return `'${value.replace(/'/g, "''")}'`;
}

export interface CsvImport {
  table: string;
  sql: string;
  /** Rows in the file (after the header), and how many were imported. */
  rows: number;
  imported: number;
}

/** The SQL making `fileName`'s CSV a table. Throws an Error saying why, for a file that isn't a table. */
export function csvToSql(fileName: string, text: string): CsvImport {
  const all = parseCsv(text);
  if (all.length < 1) throw new Error("The file is empty.");
  const [header, ...rows] = all;
  const width = header.length;
  if (rows.some((r) => r.length !== width))
    throw new Error(
      `Every row must have ${width} values, like the first row: one has ${rows.find((r) => r.length !== width)?.length}.`,
    );
  const table = sqlName(fileName.replace(/\.[^.]*$/, ""), "imported");
  const used = new Set<string>();
  const names = header.map((h, i) => {
    let name = sqlName(h, `column_${i + 1}`);
    if (RESERVED.has(name)) name = `${name}_`;
    while (used.has(name)) name = `${name}_${i + 1}`;
    used.add(name);
    return name;
  });
  const kept = rows.slice(0, MAX_CSV_ROWS);
  const types = names.map((_, i) => typeOf(rows.map((r) => r[i])));
  const lines = [
    `-- From ${fileName}${rows.length > kept.length ? ` (its first ${kept.length} of ${rows.length} rows)` : ""}`,
    `CREATE TABLE ${table} (`,
    names.map((n, i) => `  ${n} ${types[i]}`).join(",\n"),
    ");",
  ];
  if (kept.length) {
    lines.push(
      `INSERT INTO ${table} VALUES`,
      `${kept.map((r) => `  (${r.map((v, i) => literal(v, types[i])).join(", ")})`).join(",\n")};`,
    );
  }
  return { table, sql: `${lines.join("\n")}\n`, rows: rows.length, imported: kept.length };
}
