/**
 * The instrumenter's first two passes (see instrument.ts): normalize bodies
 * into blocks, then, with Babel's scope information, work out what each
 * statement can see, which variables each closure captures, where loops are,
 * and which names index which arrays.
 */
import { generate } from "@babel/generator";
import traverse, { type NodePath, type Scope } from "@babel/traverse";
import * as t from "@babel/types";
import type { GridAccess, LoopInfo } from "../trace/types";
import { RUNTIME } from "./transform";

export interface FunctionData {
  name: string;
  line: number;
  vars: string[];
  withThis: boolean;
  captured: string[];
}

export interface LoopData {
  info: LoopInfo;
  outerVars: string[];
  bodyVars: string[];
}

export interface Analysis {
  lines: Map<t.Node, { line: number; vars: string[] }>;
  loops: Map<t.Node, LoopData>;
  functions: Map<t.Node, FunctionData>;
  returns: Set<t.Node>;
  continues: Map<t.Node, { loop: t.Node; vars: string[] }>;
  indexNames: Map<string, Set<string>>;
  gridAccesses: GridAccess[];
  programVars: string[];
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

export function normalize(ast: t.File): void {
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
  if (cls.parentPath?.isVariableDeclarator() && t.isIdentifier(cls.parentPath.node.id))
    return cls.parentPath.node.id.name;
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

export function analyze(ast: t.File, source: string): Analysis {
  const analysis: Analysis = {
    lines: new Map(),
    loops: new Map(),
    functions: new Map(),
    returns: new Set(),
    continues: new Map(),
    indexNames: new Map(),
    gridAccesses: [],
    programVars: [],
  };
  const usedLoopIds = new Set<string>();

  traverse(ast, {
    Program(path) {
      analysis.programVars = visibleVars(path.scope);
    },

    Function(path) {
      // Generated helpers (TypeScript enums and namespaces) have no source
      // location: they run, but untraced.
      if (!path.node.loc) {
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
      if (t.isFunctionDeclaration(node) || t.isEmptyStatement(node) || t.isBlockStatement(node) || t.isLoop(node))
        return;
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
        ? (
            path.findParent(
              (p) => p.isLabeledStatement() && p.node.label.name === label,
            ) as NodePath<t.LabeledStatement> | null
          )?.node.body
        : path.findParent((p) => p.isLoop() || p.isFunction())?.node;
      if (target && t.isLoop(target)) {
        analysis.continues.set(path.node, { loop: target, vars: snapshotVars(path) });
      }
    },

    MemberExpression(path) {
      const node = path.node;
      if (!node.computed) return;
      // grid[i] records "i" under "grid". grid[i][j] also records "j" under
      // "grid[]": a name that indexes the rows of grid.
      let key: string;
      if (t.isIdentifier(node.object)) key = node.object.name;
      else if (t.isMemberExpression(node.object) && node.object.computed && t.isIdentifier(node.object.object)) {
        key = `${node.object.object.name}[]`;
        // grid[a][b]: which cell this line touches (see trace/gridFocus.ts).
        const text = (n: t.Node) =>
          n.start != null && n.end != null ? source.slice(n.start, n.end) : generate(n).code;
        if (node.loc) {
          analysis.gridAccesses.push({
            name: node.object.object.name,
            line: node.loc.start.line,
            row: text(node.object.property),
            col: text(node.property),
          });
        }
      } else return;
      const names = analysis.indexNames.get(key) ?? new Set<string>();
      analysis.indexNames.set(key, names);
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
