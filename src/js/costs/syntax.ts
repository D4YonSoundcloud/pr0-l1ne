/** Reading the Babel AST for the complexity estimate: helpers every part of costs/ uses. */
import * as t from "@babel/types";
import type { SizeRef } from "../../trace/types";
import { ROUNDING_MATH } from "./builtins";

/** A size an expression measures; "const" when it's a fixed number. */
export type Ref = SizeRef | "const" | null;

export const isConst = (n: t.Node | null | undefined): boolean =>
  !!n &&
  (t.isNumericLiteral(n) ||
    t.isStringLiteral(n) ||
    t.isBooleanLiteral(n) ||
    t.isNullLiteral(n) ||
    (t.isUnaryExpression(n) && isConst(n.argument)) ||
    (t.isTemplateLiteral(n) && !n.expressions.length));

export function dotted(n: t.Node | null | undefined): string | null {
  if (!n) return null;
  if (t.isIdentifier(n)) return n.name;
  if (t.isThisExpression(n)) return "this";
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const base = dotted(n.object);
    return base ? `${base}.${n.property.name}` : null;
  }
  return null;
}

export function rootName(n: t.Node): string | null {
  while (t.isMemberExpression(n)) n = n.object;
  return t.isIdentifier(n) ? n.name : t.isThisExpression(n) ? "this" : null;
}

/** x / 2 (floored or not), x >> 1, x >>> 1 */
export function halves(n: t.Node | null | undefined): boolean {
  if (!n) return false;
  if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && ROUNDING_MATH.has(dotted(n.callee) ?? "")) {
    return n.arguments.some((a) => halves(a as t.Node));
  }
  if (t.isBinaryExpression(n) && n.operator === "/" && t.isNumericLiteral(n.right) && n.right.value === 2) return true;
  if (
    t.isBinaryExpression(n) &&
    (n.operator === ">>" || n.operator === ">>>") &&
    t.isNumericLiteral(n.right) &&
    n.right.value === 1
  )
    return true;
  return false;
}

export function anyNode(root: t.Node, test: (n: t.Node) => boolean): boolean {
  let found = false;
  t.traverseFast(root, (n) => {
    if (!found && test(n)) found = true;
  });
  return found;
}

export function namesIn(root: t.Node): Set<string> {
  const out = new Set<string>();
  t.traverseFast(root, (n) => {
    if (t.isIdentifier(n)) out.add(n.name);
  });
  return out;
}

export const callName = (call: t.CallExpression | t.NewExpression): string | null =>
  t.isIdentifier(call.callee)
    ? call.callee.name
    : t.isMemberExpression(call.callee) && !call.callee.computed && t.isIdentifier(call.callee.property)
      ? call.callee.property.name
      : null;

/** Statements of a function body, not descending into nested functions. */
export function shallow(root: t.Node, visit: (n: t.Node) => void): void {
  const stack: t.Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    visit(node);
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      for (const c of Array.isArray(child) ? child : [child]) {
        if (c && typeof c === "object" && "type" in c && !t.isFunction(c as t.Node) && !t.isClass(c as t.Node))
          stack.push(c as t.Node);
      }
    }
  }
}

/** What a one-line callback returns: `() => x`, or `() => { return x; }`. */
export function returned(fn: t.Node | undefined): t.Node | null {
  if (!fn || !(t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn))) return null;
  if (!t.isBlockStatement(fn.body)) return fn.body;
  const only = fn.body.body.length === 1 ? fn.body.body[0] : null;
  return only && t.isReturnStatement(only) ? (only.argument ?? null) : null;
}

let currentSource = "";
export const line = (n: t.Node) => n.loc?.start.line ?? 0;
export const sourceOf = (n: t.Node) =>
  (n.start != null && n.end != null ? currentSource.slice(n.start, n.end) : "").replace(/\s+/g, " ");

/** The program's source, for sourceOf. Set by costAnalysis before each run. */
export function setSource(source: string): void {
  currentSource = source;
}
