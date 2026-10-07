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
 * It works in three passes:
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
import traverse, { type NodePath, type Scope } from "@babel/traverse";
import * as t from "@babel/types";
import type { LoopInfo } from "../trace/types";

/** The name the runtime is passed in as. Variables with this prefix are hidden. */
export const RUNTIME = "__av";
const FRAME = "__av_f";
const ERROR = "__av_e";

export interface Instrumented {
  code: string;
  loops: LoopInfo[];
  indexNames: Record<string, string[]>;
}

/** A parse error, with the line it happened on. */
export class InstrumentError extends Error {
  constructor(message: string, readonly line: number | null) {
    super(message);
    this.name = "SyntaxError";
  }
}

interface FunctionData {
  name: string;
  line: number;
  vars: string[];
  withThis: boolean;
  captured: string[];
}

interface LoopData {
  info: LoopInfo;
  outerVars: string[];
  bodyVars: string[];
}

interface Analysis {
  lines: Map<t.Node, { line: number; vars: string[] }>;
  loops: Map<t.Node, LoopData>;
  functions: Map<t.Node, FunctionData>;
  returns: Set<t.Node>;
  continues: Map<t.Node, { loop: t.Node; vars: string[] }>;
  indexNames: Map<string, Set<string>>;
  programVars: string[];
}

/** Parse options shared by JavaScript and TypeScript. */
export function parseProgram(source: string, plugins: ("typescript")[] = []): t.File {
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
    if (t.isImportDeclaration(node) || t.isExportDeclaration(node) || t.isTSImportEqualsDeclaration(node) || t.isTSExportAssignment(node)) {
      throw new InstrumentError("import and export aren't supported. AlgoViz runs your code as a single script.", node.loc?.start.line ?? null);
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
  const sourceLine = line ? source.split("\n")[line - 1] ?? "" : "";
  if (/<[A-Za-z][\w.]*(\s[^<>]*)?>[^<]*<\/|<[A-Za-z][\w.]*[^<>]*\/>/.test(sourceLine)) return `${text} (JSX isn't supported.)`;
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
  normalize(ast);
  const analysis = analyze(ast, source);
  transform(ast, analysis);

  const loops = [...analysis.loops.values()].map((d) => d.info).sort((a, b) => a.line - b.line);
  const indexNames: Record<string, string[]> = {};
  for (const [name, subs] of analysis.indexNames) if (subs.size) indexNames[name] = [...subs].sort();
  return { code: generate(ast).code, loops, indexNames };
}

// ---------------------------------------------------------------------------
// 1. Normalize
// ---------------------------------------------------------------------------

function asBlock(statement: t.Statement): t.BlockStatement {
  if (t.isBlockStatement(statement)) return statement;
  const block = t.blockStatement([statement]);
  block.loc = statement.loc;
  return block;
}

function normalize(ast: t.File): void {
  t.traverseFast(ast, (node) => {
    if (t.isIfStatement(node)) {
      node.consequent = asBlock(node.consequent);
      if (node.alternate) node.alternate = asBlock(node.alternate);
    } else if (t.isLoop(node)) {
      node.body = asBlock(node.body);
    } else if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body)) {
      const ret = t.returnStatement(node.body);
      ret.loc = node.body.loc;
      node.body = t.blockStatement([ret]);
      node.expression = false;
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Analyze
// ---------------------------------------------------------------------------

const HIDDEN_KINDS = new Set(["local", "module", "unknown"]);
const LIST_PARENTS = new Set(["Program", "BlockStatement", "SwitchCase", "StaticBlock"]);

/** Every variable visible at this scope, up to the enclosing function. */
function visibleVars(scope: Scope): string[] {
  const chain: Scope[] = [];
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    chain.push(s);
    if (s.path.isFunction() || s.path.isProgram()) break;
  }
  const names: string[] = [];
  for (const s of chain.reverse()) {
    for (const [name, binding] of Object.entries(s.bindings)) {
      if (HIDDEN_KINDS.has(binding.kind) || name.startsWith(RUNTIME) || names.includes(name)) continue;
      names.push(name);
    }
  }
  return names;
}

/**
 * Whether `this` means something at this point: inside a class or object
 * method, including arrow functions within one (they share its `this`).
 */
function hasThis(path: NodePath): boolean {
  let fn = path.getFunctionParent();
  while (fn?.isArrowFunctionExpression()) fn = fn.parentPath.getFunctionParent();
  return !!fn && (fn.isClassMethod() || fn.isClassPrivateMethod() || fn.isObjectMethod());
}

/** Visible variables, with "this" first when it's available (see getter()). */
function snapshotVars(path: NodePath, scope: Scope = path.scope): string[] {
  const vars = visibleVars(scope);
  return hasThis(path) ? ["this", ...vars] : vars;
}

function keyName(key: t.Node, computed: boolean): string {
  if (!computed && t.isIdentifier(key)) return key.name;
  if (t.isPrivateName(key)) return `#${key.id.name}`;
  if (t.isStringLiteral(key) || t.isNumericLiteral(key)) return String(key.value);
  return "[computed]";
}

function className(path: NodePath): string | null {
  const cls = path.findParent((p) => p.isClass()) as NodePath<t.Class> | null;
  if (!cls) return null;
  if (cls.node.id) return cls.node.id.name;
  if (cls.parentPath?.isVariableDeclarator() && t.isIdentifier(cls.parentPath.node.id)) return cls.parentPath.node.id.name;
  return null;
}

function functionName(path: NodePath<t.Function>): string {
  const node = path.node;
  if ((t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) && node.id) return node.id.name;
  if (t.isClassMethod(node) || t.isClassPrivateMethod(node) || t.isObjectMethod(node)) {
    const key = keyName(node.key, "computed" in node ? node.computed : false);
    const cls = t.isObjectMethod(node) ? null : className(path);
    return cls ? `${cls}.${key}` : key;
  }
  const parent = path.parent;
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
  if (t.isAssignmentExpression(parent)) {
    if (t.isIdentifier(parent.left)) return parent.left.name;
    if (t.isMemberExpression(parent.left) && !parent.left.computed && t.isIdentifier(parent.left.property)) {
      return parent.left.property.name;
    }
  }
  if ((t.isObjectProperty(parent) || t.isClassProperty(parent)) && !parent.computed) {
    const cls = t.isClassProperty(parent) ? className(path) : null;
    const key = keyName(parent.key, false);
    return cls ? `${cls}.${key}` : key;
  }
  return "anonymous";
}

/** Variables from enclosing functions (not the program) that this function uses. */
function capturedVars(path: NodePath<t.Function>): string[] {
  const captured: string[] = [];
  for (let scope = path.scope.parent; scope && !scope.path.isProgram(); scope = scope.parent) {
    for (const [name, binding] of Object.entries(scope.bindings)) {
      if (HIDDEN_KINDS.has(binding.kind) || captured.includes(name)) continue;
      const uses = [...binding.referencePaths, ...binding.constantViolations];
      if (uses.some((use) => path.isAncestor(use))) captured.push(name);
    }
  }
  return captured;
}

function loopHeader(path: NodePath<t.Loop>, source: string): string {
  const node = path.node;
  if (t.isDoWhileStatement(node)) {
    return `do … while (${source.slice(node.test.start ?? 0, node.test.end ?? 0)})`;
  }
  const line = source.split("\n")[(node.loc?.start.line ?? 1) - 1] ?? "";
  return line.trim().replace(/\s*\{?\s*$/, "");
}

function analyze(ast: t.File, source: string): Analysis {
  const analysis: Analysis = {
    lines: new Map(),
    loops: new Map(),
    functions: new Map(),
    returns: new Set(),
    continues: new Map(),
    indexNames: new Map(),
    programVars: [],
  };
  const usedLoopIds = new Set<string>();

  traverse(ast, {
    Program(path) {
      analysis.programVars = visibleVars(path.scope);
    },

    Function(path) {
      // Generators and async functions can suspend mid-body, which the
      // runtime's shadow call stack can't follow. They run untraced, and so
      // do generated helpers, which have no source location.
      if (path.node.async || path.node.generator || !path.node.loc) {
        path.skip();
        return;
      }
      const node = path.node;
      const isMethod = t.isClassMethod(node) || t.isClassPrivateMethod(node) || t.isObjectMethod(node);
      analysis.functions.set(node, {
        name: functionName(path),
        line: node.loc?.start.line ?? 0,
        vars: visibleVars(path.scope),
        withThis: isMethod,
        captured: isMethod ? [] : capturedVars(path),
      });
    },

    Statement(path) {
      const node = path.node;
      if (!path.inList || !LIST_PARENTS.has(path.parent.type) || !node.loc) return;
      if (t.isFunctionDeclaration(node) || t.isEmptyStatement(node) || t.isBlockStatement(node) || t.isLoop(node)) return;
      if (t.isLabeledStatement(node) && t.isLoop(node.body)) return;
      analysis.lines.set(node, { line: node.loc?.start.line ?? 0, vars: snapshotVars(path) });
    },

    Loop(path) {
      const node = path.node;
      if (!node.loc) return;
      const line = node.loc?.start.line ?? 0;
      let id = `L${line}`;
      if (usedLoopIds.has(id)) id = `L${line}_${node.loc?.start.column ?? 0}`;
      usedLoopIds.add(id);
      const body = node.body as t.BlockStatement;
      const first = body.body[0];
      const last = body.body[body.body.length - 1];
      analysis.loops.set(node, {
        info: {
          id,
          kind: t.isWhileStatement(node) || t.isDoWhileStatement(node) ? "while" : "for",
          line,
          bodyStart: first?.loc?.start.line ?? line,
          bodyEnd: last?.loc?.end.line ?? line,
          header: loopHeader(path, source),
        },
        outerVars: snapshotVars(path, path.parentPath!.scope),
        bodyVars: snapshotVars(path, path.get("body").scope),
      });
    },

    ReturnStatement(path) {
      analysis.returns.add(path.node);
    },

    ContinueStatement(path) {
      const label = path.node.label?.name;
      const target = label
        ? (path.findParent((p) => p.isLabeledStatement() && p.node.label.name === label) as NodePath<t.LabeledStatement> | null)?.node.body
        : path.findParent((p) => p.isLoop() || p.isFunction())?.node;
      if (target && t.isLoop(target)) {
        analysis.continues.set(path.node, { loop: target, vars: snapshotVars(path) });
      }
    },

    MemberExpression(path) {
      const node = path.node;
      if (!node.computed || !t.isIdentifier(node.object)) return;
      const names = analysis.indexNames.get(node.object.name) ?? new Set<string>();
      analysis.indexNames.set(node.object.name, names);
      const property = path.get("property");
      if (property.isIdentifier()) names.add(property.node.name);
      property.traverse({
        ReferencedIdentifier(p) {
          if (p.isIdentifier()) names.add(p.node.name);
        },
      });
    },
  });

  return analysis;
}

// ---------------------------------------------------------------------------
// 3. Transform
// ---------------------------------------------------------------------------

const runtimeCall = (method: string, args: t.Expression[]) =>
  t.callExpression(t.memberExpression(t.identifier(RUNTIME), t.identifier(method)), args);

const statement = (method: string, args: t.Expression[]) => t.expressionStatement(runtimeCall(method, args));

const VOID = () => t.unaryExpression("void", t.numericLiteral(0));

/** () => [["a", () => a], ["b", () => b]] */
function getter(vars: string[], withThis = false): t.ArrowFunctionExpression {
  const pair = (name: string, value: t.Expression) =>
    t.arrayExpression([t.stringLiteral(name), t.arrowFunctionExpression([], value)]);
  // "this" isn't a variable name, so it's safe to use as a marker for `this`.
  const pairs = vars.map((name) => pair(name, name === "this" ? t.thisExpression() : t.identifier(name)));
  if (withThis) pairs.unshift(pair("this", t.thisExpression()));
  return t.arrowFunctionExpression([], t.arrayExpression(pairs));
}

function transform(ast: t.File, a: Analysis): void {
  const loopOf = (node: t.Statement): LoopData | undefined =>
    a.loops.get(t.isLabeledStatement(node) ? node.body : node);

  /** Insert line events, loop wrappers and closure registrations into a list. */
  function processList(list: t.Statement[]): t.Statement[] {
    const out: t.Statement[] = [];
    const registrations: t.Statement[] = [];
    for (const node of list) {
      const loop = loopOf(node);
      if (loop) {
        // Wrap the loop (with its label, if any, so `continue label` still works).
        const { id, line } = loop.info;
        out.push(t.blockStatement([
          statement("loopEnter", [t.stringLiteral(id), t.numericLiteral(line), getter(loop.outerVars)]),
          t.tryStatement(t.blockStatement([node]), null, t.blockStatement([statement("loopExit", [t.stringLiteral(id)])])),
        ]));
        continue;
      }
      const info = a.lines.get(node);
      if (info) out.push(statement("line", [t.numericLiteral(info.line), getter(info.vars)]));
      const cont = a.continues.get(node);
      const contLoop = cont && a.loops.get(cont.loop);
      if (cont && contLoop) {
        // `continue` ends the iteration early, so record the end-of-iteration
        // snapshot here too.
        out.push(statement("tail", [t.stringLiteral(contLoop.info.id), t.numericLiteral(contLoop.info.line), getter(cont.vars)]));
      }
      out.push(node);
      const fn = t.isFunctionDeclaration(node) ? a.functions.get(node) : undefined;
      if (fn?.captured.length && t.isFunctionDeclaration(node) && node.id) {
        // Declarations are hoisted, so register them at the top of the block.
        registrations.push(statement("fn", [t.identifier(node.id.name), t.stringLiteral(fn.name), getter(fn.captured)]));
      }
    }
    return [...registrations, ...out];
  }

  /** Wrap a function body in enter / try / catch / finally exit. */
  function wrapBody(body: t.BlockStatement, name: string, line: number, vars: string[], withThis: boolean): t.BlockStatement {
    const frame = t.identifier(FRAME);
    const error = t.identifier(ERROR);
    return t.blockStatement([
      t.variableDeclaration("const", [
        t.variableDeclarator(frame, runtimeCall("enter", [t.stringLiteral(name), t.numericLiteral(line), getter(vars, withThis)])),
      ]),
      t.tryStatement(
        t.blockStatement([...body.body, statement("ret", [VOID(), getter(vars, withThis)])]),
        t.catchClause(error, t.blockStatement([statement("raise", [error]), t.throwStatement(error)])),
        t.blockStatement([statement("exit", [frame])]),
      ),
    ], body.directives);
  }

  t.traverse(ast, {
    exit(node, ancestors) {
      if (t.isProgram(node)) {
        node.body = [...wrapBody(t.blockStatement(processList(node.body)), "Global", 0, a.programVars, false).body];
        return;
      }
      if (t.isBlockStatement(node) || t.isStaticBlock(node)) {
        node.body = processList(node.body);
        return;
      }
      if (t.isSwitchCase(node)) {
        node.consequent = processList(node.consequent);
        return;
      }

      const loop = a.loops.get(node);
      if (loop && t.isLoop(node) && t.isBlockStatement(node.body)) {
        const { id, line } = loop.info;
        node.body.body.unshift(statement("loopIter", [t.stringLiteral(id)]));
        node.body.body.push(statement("tail", [t.stringLiteral(id), t.numericLiteral(line), getter(loop.bodyVars)]));
        return;
      }

      if (t.isReturnStatement(node) && a.returns.has(node)) {
        node.argument = runtimeCall("ret", [node.argument ?? VOID()]);
        return;
      }

      const fn = a.functions.get(node);
      if (fn && t.isFunction(node) && t.isBlockStatement(node.body)) {
        node.body = wrapBody(node.body, fn.name, fn.line, fn.vars, fn.withThis);
        // Closures: register captured variables so the heap view can show
        // them. Function declarations are registered in processList instead.
        if (fn.captured.length && (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node))) {
          const wrapped = runtimeCall("fn", [node, t.stringLiteral(fn.name), getter(fn.captured)]);
          const parent = ancestors[ancestors.length - 1];
          const slot = (parent.node as unknown as Record<string, unknown>)[parent.key];
          if (Array.isArray(slot)) slot[parent.index!] = wrapped;
          else (parent.node as unknown as Record<string, unknown>)[parent.key] = wrapped;
        }
      }
    },
  });
}
