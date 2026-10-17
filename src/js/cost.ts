/**
 * The shape of a JavaScript or TypeScript program, for complexity estimates:
 * the same CostInfo the Python tracer writes (see the comment in tracer.py
 * and trace/complexity.ts). Runs on the Babel AST before instrumentation.
 * The analysis is in costs/: shape.ts reads each function, and arrays.ts,
 * strings.ts, maps.ts and builtins.ts say what each built-in costs.
 *
 * Array methods that take a callback (forEach, map, filter, reduce, ...) are
 * loops too, with the callback's body as the loop's body.
 */
import _traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { CostFunction, CostInfo, CostNode } from "../trace/types";
import { Shape } from "./costs/shape";
import { setSource } from "./costs/syntax";

// @babel/traverse is CommonJS; under some bundlers the function is on .default.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

function paramNames(fn: t.Function): string[] {
  const out: string[] = [];
  for (const p of fn.params) {
    const id = t.isAssignmentPattern(p) ? p.left : t.isTSParameterProperty(p) ? p.parameter : p;
    const target = t.isAssignmentPattern(id) ? id.left : id;
    if (t.isIdentifier(target)) out.push(target.name);
    else out.push("");
  }
  return out;
}

function iterCalls(nodes: CostNode[], visit: (c: Extract<CostNode, { kind: "call" }>) => void): void {
  for (const n of nodes) {
    if (n.kind === "call") visit(n);
    else if (n.kind === "loop") iterCalls(n.body, visit);
  }
}

/**
 * The CostInfo for a parsed program. `names` gives each function the name its
 * frames have at run time; `loopIds` gives each loop its LoopInfo id.
 */
export function costAnalysis(
  ast: t.File,
  source: string,
  names: Map<t.Node, string>,
  loopIds: Map<t.Node, string>,
): CostInfo {
  setSource(source);
  const userFunctions = new Map<string, string>(); // short name -> frame name
  const fns: [t.Function, string][] = [];
  traverse(ast, {
    Function(path: NodePath<t.Function>) {
      const name = names.get(path.node);
      if (!name || name === "anonymous" || !path.node.loc) return;
      // Callbacks passed inline are part of the loop they're in, not functions of their own.
      if (
        (t.isArrowFunctionExpression(path.node) || t.isFunctionExpression(path.node)) &&
        t.isCallExpression(path.parent)
      )
        return;
      fns.push([path.node, name]);
      const short = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
      if (!userFunctions.has(short)) userFunctions.set(short, name);
    },
  });
  const functions: CostFunction[] = [];
  const top = new Shape("Global", 1, [], ast.program.body, userFunctions, true, loopIds);
  functions.push(top.build(false));
  for (const [fn, name] of fns) {
    const body = t.isBlockStatement(fn.body) ? fn.body.body : [t.returnStatement(fn.body as t.Expression)];
    const shape = new Shape(name, fn.loc?.start.line ?? 0, paramNames(fn), body, userFunctions, false, loopIds);
    const built = shape.build(shape.memoized());
    if (shape.explores())
      iterCalls(built.body, (c) => {
        if (c.callee === name) c.shrink = "unknown";
      });
    functions.push(built);
  }
  return { functions };
}
