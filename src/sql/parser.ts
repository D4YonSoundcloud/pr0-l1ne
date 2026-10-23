/**
 * Postgres's own parser (libpg_query, compiled to WebAssembly) and a
 * deparser that writes a parse tree back as SQL. The tracer reads a query's
 * clauses from the tree, and writes the smaller queries it runs for each
 * step from the clauses' trees: anything Postgres accepts parses exactly as
 * Postgres parses it.
 *
 * Positions in the tree (`location`, `stmt_location`) count bytes of the
 * script in UTF-8, not characters: see SourceText in script.ts.
 *
 * The parser is loaded here rather than through the package's own entry
 * point, which starts loading its WebAssembly as soon as it's imported,
 * from beside the page that imports it (in a build, the wrong folder).
 * Here it's told where the file is: the copy Vite puts in the build.
 */
// @ts-expect-error: Emscripten's loader for the parser, untyped.
import createParserModule from "libpg-query/wasm/libpg-query.js";
import parserWasmUrl from "libpg-query/wasm/libpg-query.wasm?url";
import { deparse } from "pgsql-deparser";

/** A node of the parse tree: `{ SelectStmt: {...} }`, `{ ColumnRef: {...} }`... */
// biome-ignore lint/suspicious/noExplicitAny: the parse tree is Postgres's, hundreds of node types; read with care.
export type Node = Record<string, any>;

export interface RawStatement {
  stmt: Node;
  /** In bytes; absent: from the start (0) / to the end. */
  stmt_location?: number;
  stmt_len?: number;
}

/** Why the script couldn't be parsed, and where (a byte offset into it). */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly byteOffset: number | null,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

export interface SqlParser {
  /** Every statement of a script. Throws a ParseError. */
  parse(sql: string): Promise<RawStatement[]>;
  /** A node written back as SQL. */
  deparse(node: Node): Promise<string>;
}

/** The parts of the Emscripten module the parser calls. */
interface ParserModule {
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, ptr: number, max: number): void;
  UTF8ToString(ptr: number): string;
  getValue(ptr: number, type: "i32"): number;
  _malloc(n: number): number;
  _free(ptr: number): void;
  _wasm_parse_query_raw(ptr: number): number;
  _wasm_free_parse_result(ptr: number): void;
}

/** In Node (the tests), Emscripten finds the file itself; in a browser, at Vite's copy. */
const inNode =
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";

/**
 * Parse a script. As libpg-query's own `parse` does: the result is a
 * struct of three pointers, the tree as JSON, its stderr, and an error.
 */
function parseWith(module: ParserModule, sql: string): RawStatement[] {
  if (!sql.trim()) return [];
  const length = module.lengthBytesUTF8(sql) + 1;
  const input = module._malloc(length);
  let result = 0;
  try {
    module.stringToUTF8(sql, input, length);
    result = module._wasm_parse_query_raw(input);
    if (!result) throw new Error("the SQL parser ran out of memory");
    const tree = module.getValue(result, "i32");
    const error = module.getValue(result + 8, "i32");
    if (error) {
      const message = module.getValue(error, "i32");
      const cursor = module.getValue(error + 16, "i32");
      throw new ParseError(message ? module.UTF8ToString(message) : "syntax error", cursor > 0 ? cursor - 1 : null);
    }
    if (!tree) return [];
    return (JSON.parse(module.UTF8ToString(tree)) as { stmts?: RawStatement[] }).stmts ?? [];
  } finally {
    module._free(input);
    if (result) module._wasm_free_parse_result(result);
  }
}

let loaded: Promise<SqlParser> | null = null;

/** The parser, once its WebAssembly has loaded. */
export function loadParser(): Promise<SqlParser> {
  loaded ??= (createParserModule(inNode ? {} : { locateFile: () => parserWasmUrl }) as Promise<ParserModule>).then(
    (module) => ({
      async parse(sql: string): Promise<RawStatement[]> {
        return parseWith(module, sql);
      },
      async deparse(node: Node): Promise<string> {
        // Not tidied: the text runs as SQL (collapsing spaces would change a string literal).
        return (await deparse(node as never, { pretty: false })).trim();
      },
    }),
  );
  return loaded;
}
