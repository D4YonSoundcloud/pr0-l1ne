/**
 * The Import CSV button (SQL only): pick a CSV file, and its table is added
 * to the program, as CREATE TABLE and INSERT (sql/csv.ts), at the cursor.
 * The file is read here in the browser; nothing is sent anywhere.
 */
import { csvToSql } from "../sql/csv";
import type { BannerTone } from "./banner";
import { escapeHtml } from "./html";

/** Files bigger than this aren't read: a program is for reading, not a data store. */
export const MAX_CSV_BYTES = 1_000_000;

export interface CsvImportOptions {
  button: HTMLButtonElement;
  input: HTMLInputElement;
  /** Put SQL into the program at the cursor (on lines of its own). */
  insert(sql: string): void;
  setBanner(html: string | null, tone?: BannerTone): void;
}

export class CsvImportController {
  constructor(private readonly options: CsvImportOptions) {
    const { button, input } = options;
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = ""; // the same file again is a new import
      if (file) void this.importFile(file);
    });
  }

  async importFile(file: Pick<File, "name" | "size" | "text">): Promise<void> {
    const { insert, setBanner } = this.options;
    if (file.size > MAX_CSV_BYTES) {
      setBanner(
        `<strong>${escapeHtml(file.name)} is too big to import</strong> (${Math.round(file.size / 1000)} KB): a CSV file of up to ${MAX_CSV_BYTES / 1_000_000} MB can be imported.`,
        "hint",
      );
      return;
    }
    try {
      const made = csvToSql(file.name, await file.text());
      insert(made.sql);
      const cut = made.imported < made.rows ? ` (the first ${made.imported} of its ${made.rows} rows)` : "";
      setBanner(
        `Added the table <strong>${escapeHtml(made.table)}</strong> from ${escapeHtml(file.name)}: ${made.imported} ${made.imported === 1 ? "row" : "rows"}${cut}, as CREATE TABLE and INSERT in your program.`,
        "hint",
      );
    } catch (error) {
      setBanner(
        `<strong>${escapeHtml(file.name)} couldn't be imported.</strong> ${escapeHtml(error instanceof Error ? error.message : String(error))}`,
        "hint",
      );
    }
  }
}
