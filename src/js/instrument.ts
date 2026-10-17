/**
 * JavaScript instrumenter.
 *
 * Python gives us sys.settrace. JavaScript has nothing like it inside a page,
 * so instead we rewrite the user's program to report on itself. For example:
 *
 *   let total = 0;                    __av.line(1, () => [["total", () => total]]);
 *   for (const x of xs) {             let total = 0;
 *     total += x;            ──▶      __av.loopEnter("L2", 2, getter);
 *   }                                 try {
 *                                       for (const x of xs) {
 *                                         __av.loopIter("L2");
 *                                         __av.line(3, getter);
 *                                         total += x;
 *                                         __av.tail("L2", 2, getter);
 *                                       }
 *                                     } finally { __av.loopExit("L2"); }
 *
 * `__av` is the Runtime (runtime.ts). Each "getter" is a list of
 * [name, () => value] pairs for every variable visible at that point, so the
 * runtime can read the live values whenever it takes a snapshot.
 *
 * It works in three passes (the first two in analyze.ts, the third in transform.ts):
 *   1. normalize  Make bodies into blocks so there's always a statement list
 *                 to insert into (`if (x) y()` becomes `if (x) { y() }`).
 *   2. analyze    With Babel's scope information, work out what each
 *                 statement can see, which variables each closure captures,
 *                 where loops are, and which names index which arrays.
 *   3. transform  Insert the calls. Done as a plain post-order walk that
 *                 mutates nodes directly, so nothing is visited twice.
 */
import { generate } from "@babel/generator";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import type { CostInfo, GridAccess, LoopInfo, RawHint } from "../trace/types";
import { analyze, normalize } from "./analyze";
import { costAnalysis } from "./cost";
import { RUNTIME, transform } from "./transform";

export { RUNTIME };

export interface Instrumented {
  code: string;
  loops: LoopInfo[];
  indexNames: Record<string, string[]>;
  /** Every grid[a][b] (see Trace.gridAccesses). */
  gridAccesses: GridAccess[];
  /** `// viz: ...` comments, unparsed (see trace/hints.ts). */
  hints: RawHint[];
  /** The code's shape, for complexity estimates (see js/cost.ts). */
  cost?: CostInfo;
}

/** Matches a hint comment's text: "viz: hide i". */
const HINT = /^\s*viz\s*:(.*)$/;

/** Every `// viz:` or `/* viz: *\/` comment, with its line. */
function collectHints(ast: t.File): RawHint[] {
  const hints: RawHint[] = [];
  for (const comment of ast.comments ?? []) {
    const match = HINT.exec(comment.value);
    if (match) hints.push({ line: comment.loc?.start.line ?? 0, text: match[1].trim() });
  }
  return hints;
}

/** A parse error, with the line it happened on. */
export class InstrumentError extends Error {
  constructor(
    message: string,
    readonly line: number | null,
  ) {
    super(message);
    this.name = "SyntaxError";
  }
}

/** Parse options shared by JavaScript and TypeScript. */
export function parseProgram(source: string, plugins: "typescript"[] = []): t.File {
  let ast: t.File;
  try {
    // allowImportExportEverywhere lets TypeScript namespaces contain `export`.
    // Real top-level imports and exports are rejected just below, with a
    // clearer message than the parser's.
    ast = parse(source, { sourceType: "script", allowImportExportEverywhere: true, plugins });
  } catch (error) {
    const err = error as { message: string; loc?: { line: number } };
    throw new InstrumentError(friendlyParseError(err.message, source, err.loc?.line), err.loc?.line ?? null);
  }
  for (const node of ast.program.body) {
    if (
      t.isImportDeclaration(node) ||
      t.isExportDeclaration(node) ||
      t.isTSImportEqualsDeclaration(node) ||
      t.isTSExportAssignment(node)
    ) {
      throw new InstrumentError(
        "import and export aren't supported. AlgoViz runs your code as a single script.",
        node.loc?.start.line ?? null,
      );
    }
  }
  return ast;
}

/** Babel's messages are written for people configuring Babel. Translate the common ones. */
function friendlyParseError(message: string, source: string, line?: number): string {
  const text = message.replace(/\s*\(\d+:\d+\)\s*$/, "");
  if (/parser plugin\(s\): "decorators"/.test(text)) return "Decorators aren't supported.";
  if (/parser plugin\(s\): "jsx"/.test(text)) return "JSX isn't supported.";
  // JSX in TypeScript mode usually fails with an odd message about type
  // assertions or regular expressions. If the line looks like JSX, say so.
  const sourceLine = line ? (source.split("\n")[line - 1] ?? "") : "";
  if (/<[A-Za-z][\w.]*(\s[^<>]*)?>[^<]*<\/|<[A-Za-z][\w.]*[^<>]*\/>/.test(sourceLine))
    return `${text} (JSX isn't supported.)`;
  return text;
}

/** Parse and instrument plain JavaScript. */
export function instrument(source: string): Instrumented {
  return instrumentAst(parseProgram(source), source);
}

/**
 * Instrument an already-parsed program. Nodes without a source location are
 * treated as compiler-generated (TypeScript's enum and namespace helpers,
 * `this.x = x` for parameter properties): they run, but aren't traced.
 */
export function instrumentAst(ast: t.File, source: string): Instrumented {
  const hints = collectHints(ast);
  normalize(ast);
  const analysis = analyze(ast, source);
  let cost: CostInfo | undefined;
  try {
    const names = new Map<t.Node, string>([...analysis.functions].map(([node, data]) => [node, data.name]));
    const loopIds = new Map<t.Node, string>([...analysis.loops].map(([node, data]) => [node, data.info.id]));
    cost = costAnalysis(ast, source, names, loopIds);
  } catch {
    // A guess about the code's shape must never stop a run.
  }
  transform(ast, analysis);

  const loops = [...analysis.loops.values()].map((d) => d.info).sort((a, b) => a.line - b.line);
  const indexNames: Record<string, string[]> = {};
  for (const [name, subs] of analysis.indexNames) if (subs.size) indexNames[name] = [...subs].sort();
  const gridAccesses = [...analysis.gridAccesses].sort((a, b) => a.line - b.line);
  return { code: generate(ast).code, loops, indexNames, gridAccesses, hints, ...(cost ? { cost } : {}) };
}
