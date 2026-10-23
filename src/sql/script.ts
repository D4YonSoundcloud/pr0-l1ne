/**
 * The script as text: lines, and the byte offsets Postgres's parser counts
 * in (UTF-8) turned into characters and lines. Also the one hint a SQL
 * program has, `-- viz: database shop`.
 */

export class SourceText {
  private readonly bytes: Uint8Array;
  /** Character index of each byte offset, when the script isn't all ASCII. */
  private readonly charAt: number[] | null;
  private readonly lineStarts: number[];

  constructor(readonly text: string) {
    this.bytes = new TextEncoder().encode(text);
    if (this.bytes.length === text.length) {
      this.charAt = null;
    } else {
      this.charAt = [];
      let char = 0;
      for (const ch of text) {
        const n = new TextEncoder().encode(ch).length;
        for (let i = 0; i < n; i++) this.charAt.push(char);
        char += ch.length;
      }
      this.charAt.push(char);
    }
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.lineStarts.push(i + 1);
  }

  get byteLength(): number {
    return this.bytes.length;
  }

  /** The character index of a byte offset. */
  char(byteOffset: number): number {
    const at = Math.max(0, Math.min(byteOffset, this.bytes.length));
    return this.charAt ? this.charAt[at] : at;
  }

  /** The line (from 1) a character index is on. */
  lineOfChar(index: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** The line (from 1) a byte offset is on. */
  lineOf(byteOffset: number): number {
    return this.lineOfChar(this.char(byteOffset));
  }

  /** The text between two byte offsets. */
  slice(fromByte: number, toByte: number): string {
    return this.text.slice(this.char(fromByte), this.char(toByte));
  }
}

/**
 * Where a statement's own text starts: past the blank lines and comments
 * before it (the parser's statement location can include them).
 */
export function skipToCode(text: string, from = 0): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      return i;
    }
  }
}

/** Text on one line, shortened to `max` characters. */
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A `-- viz: database name` line: which sample database the program starts from. */
export interface DatabaseHint {
  name: string;
  line: number;
}

const HINT = /^\s*--\s*viz:\s*(.*?)\s*$/i;

/**
 * The script's `-- viz:` hints: the database it asks for (the first, if it
 * names several), and any hint that isn't one SQL understands.
 */
export function readHints(text: string): { database: DatabaseHint | null; unknown: { line: number; text: string }[] } {
  let database: DatabaseHint | null = null;
  const unknown: { line: number; text: string }[] = [];
  text.split("\n").forEach((lineText, i) => {
    const m = HINT.exec(lineText);
    if (!m) return;
    const db = /^database\s+([A-Za-z_][\w]*)$/i.exec(m[1]);
    if (db) database ??= { name: db[1], line: i + 1 };
    else unknown.push({ line: i + 1, text: m[1] });
  });
  return { database, unknown };
}
