/**
 * The shape of a JavaScript or TypeScript program, for complexity estimates:
 * the same CostInfo the Python tracer writes (see the comment in tracer.py
 * and trace/complexity.ts). Runs on the Babel AST before instrumentation.
 *
 * Array methods that take a callback (forEach, map, filter, reduce, ...) are
 * loops too, with the callback's body as the loop's body.
 */
import _traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { CostBound, CostFunction, CostInfo, CostNode, Shrink, SizeRef } from "../trace/types";

// @babel/traverse is CommonJS; under some bundlers the function is on .default.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

type Ref = SizeRef | "const" | null;

const CALLBACK_LOOPS = new Set(["forEach", "map", "filter", "reduce", "reduceRight", "some", "every", "find", "findIndex",
  "findLast", "findLastIndex", "flatMap"]);
const LINEAR_METHODS = new Set(["includes", "indexOf", "lastIndexOf", "join", "slice", "concat", "reverse", "splice",
  "shift", "unshift", "fill", "toString", "split", "repeat", "toReversed", "toSorted", "with", "flat"]);
const COPY_METHODS = new Set(["slice", "concat", "toReversed", "toSorted", "split", "flat", "map", "filter", "flatMap"]);
const GROW_METHODS = new Set(["push", "unshift", "add", "set"]);
const HASHED = new Set(["has", "get", "set", "add", "delete"]);

const isConst = (n: t.Node | null | undefined): boolean =>
  !!n && (t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n) || t.isNullLiteral(n) ||
    (t.isUnaryExpression(n) && isConst(n.argument)) || (t.isTemplateLiteral(n) && !n.expressions.length));

function dotted(n: t.Node | null | undefined): string | null {
  if (!n) return null;
  if (t.isIdentifier(n)) return n.name;
  if (t.isThisExpression(n)) return "this";
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const base = dotted(n.object);
    return base ? `${base}.${n.property.name}` : null;
  }
  return null;
}

function rootName(n: t.Node): string | null {
  while (t.isMemberExpression(n)) n = n.object;
  return t.isIdentifier(n) ? n.name : t.isThisExpression(n) ? "this" : null;
}

/** x / 2 (floored or not), x >> 1, x >>> 1 */
function halves(n: t.Node | null | undefined): boolean {
  if (!n) return false;
  if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && dotted(n.callee) && /^Math\.(floor|trunc|ceil|round)$/.test(dotted(n.callee)!)) {
    return n.arguments.some((a) => halves(a as t.Node));
  }
  if (t.isBinaryExpression(n) && (n.operator === "/" && t.isNumericLiteral(n.right) && n.right.value === 2)) return true;
  if (t.isBinaryExpression(n) && (n.operator === ">>" || n.operator === ">>>") && t.isNumericLiteral(n.right) && n.right.value === 1) return true;
  return false;
}

function anyNode(root: t.Node, test: (n: t.Node) => boolean): boolean {
  let found = false;
  t.traverseFast(root, (n) => { if (!found && test(n)) found = true; });
  return found;
}

function namesIn(root: t.Node): Set<string> {
  const out = new Set<string>();
  t.traverseFast(root, (n) => { if (t.isIdentifier(n)) out.add(n.name); });
  return out;
}

const callName = (call: t.CallExpression | t.NewExpression): string | null =>
  t.isIdentifier(call.callee) ? call.callee.name
    : t.isMemberExpression(call.callee) && !call.callee.computed && t.isIdentifier(call.callee.property) ? call.callee.property.name
      : null;

/** Statements of a function body, not descending into nested functions. */
function shallow(root: t.Node, visit: (n: t.Node) => void): void {
  const stack: t.Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    visit(node);
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      for (const c of Array.isArray(child) ? child : [child]) {
        if (c && typeof c === "object" && "type" in c && !t.isFunction(c as t.Node) && !t.isClass(c as t.Node)) stack.push(c as t.Node);
      }
    }
  }
}

class Shape {
  aliases = new Map<string, SizeRef>();
  indexVars = new Map<string, SizeRef | null>();
  elements = new Map<string, SizeRef>();
  mids = new Set<string>();
  containers = new Map<string, "list" | "dict" | "set">();
  inits = new Map<string, t.Node>();
  recursive: [string, t.Node][][] = [];
  /** Calls that are the whole of a return: only one of them runs per call. */
  returned = new Set<t.Node>();

  constructor(
    readonly name: string,
    readonly line: number,
    readonly params: string[],
    readonly body: t.Node[],
    readonly userFunctions: Map<string, string>,
    readonly isGlobal: boolean,
    readonly loopIds: Map<t.Node, string>,
  ) {
    this.learnAll();
    for (const root of body) shallow(root, (n) => {
      if (t.isForOfStatement(n) || t.isForInStatement(n) || t.isForStatement(n)) this.forBound(n);
    });
    this.aliases.clear();
    this.inits.clear();
    this.learnAll();
  }

  private learnAll(): void {
    for (const root of this.body) shallow(root, (n) => {
      if (t.isVariableDeclarator(n) && n.init) this.learn(n.id, n.init);
      else if (t.isAssignmentExpression(n) && n.operator === "=") this.learn(n.left, n.right);
    });
  }

  private learn(target: t.Node, value: t.Node): void {
    if (t.isArrayPattern(target) && t.isArrayExpression(value) && target.elements.length === value.elements.length) {
      target.elements.forEach((el, i) => { if (el && value.elements[i]) this.learn(el, value.elements[i]!); });
      return;
    }
    if (!t.isIdentifier(target)) return;
    const name = target.name;
    if (!this.inits.has(name)) this.inits.set(name, value);
    if (anyNode(value, halves) && !namesIn(value).has(name)) this.mids.add(name);
    const kind = this.containerKind(value);
    if (kind && !this.containers.has(name)) this.containers.set(name, kind);
    if (!this.aliases.has(name) && !this.params.includes(name)) {
      // const queue = [...items], const sorted = items.slice().sort(): as big as items
      const copy = t.isArrayExpression(value) || t.isCallExpression(value) || t.isNewExpression(value) ? this.lengthOf(value) : null;
      const ref = this.sizeOf(value, true) ?? (copy && copy !== "const" ? copy : null);
      if (ref && ref !== "const" && ref.name !== name) this.aliases.set(name, ref);
    }
  }

  private containerKind(v: t.Node): "list" | "dict" | "set" | null {
    if (t.isArrayExpression(v)) return "list";
    if (t.isObjectExpression(v)) return "dict";
    if (t.isNewExpression(v) && t.isIdentifier(v.callee)) {
      if (v.callee.name === "Map" || v.callee.name === "WeakMap") return "dict";
      if (v.callee.name === "Set" || v.callee.name === "WeakSet") return "set";
      if (v.callee.name === "Array") return "list";
    }
    return null;
  }

  /** The size an expression measures. */
  sizeOf(n: t.Node | null | undefined, allowValue = false): Ref {
    if (!n) return null;
    if (isConst(n)) return "const";
    if (t.isTSAsExpression(n) || t.isTSNonNullExpression(n) || t.isParenthesizedExpression(n)) return this.sizeOf(n.expression, allowValue);
    if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property) && (n.property.name === "length" || n.property.name === "size")) {
      return this.lengthOf(n.object);
    }
    if (t.isIdentifier(n)) {
      if (this.indexVars.has(n.name)) return this.indexVars.get(n.name) ?? "const";
      if (this.aliases.has(n.name)) return this.aliases.get(n.name)!;
      if (this.mids.has(n.name)) return null;
      return allowValue ? { name: n.name } : null;
    }
    if (t.isMemberExpression(n)) {
      const d = dotted(n);
      return d && allowValue ? { name: d } : null;
    }
    if (t.isBinaryExpression(n)) {
      if (halves(n)) return null;
      const sides = [n.left, n.right].map((s) => this.sizeOf(s as t.Node, allowValue));
      const refs = sides.filter((r): r is SizeRef => !!r && r !== "const");
      if (refs.length) {
        const plain = sides.filter((r, i) => r && r !== "const" && !(t.isIdentifier([n.left, n.right][i]) && this.indexVars.has(([n.left, n.right][i] as t.Identifier).name))) as SizeRef[];
        return (plain[0] ?? refs[0]);
      }
      return sides.every((r) => r === "const") ? "const" : null;
    }
    if (t.isUnaryExpression(n)) return this.sizeOf(n.argument, allowValue);
    if (t.isCallExpression(n)) {
      const name = callName(n);
      const d = t.isMemberExpression(n.callee) ? dotted(n.callee) : null;
      if (d && /^Math\.(floor|ceil|trunc|round|abs|min|max)$/.test(d)) {
        for (const a of n.arguments) { const r = this.sizeOf(a as t.Node, allowValue); if (r && r !== "const") return r; }
        return null;
      }
      if (name && this.userFunctions.has(name) && !t.isMemberExpression(n.callee)) {
        for (const a of n.arguments) {
          const r = this.argRef(a as t.Node);
          if (r) return this.looksLikeCollection(a as t.Node) ? { ...r, len: true } : r;
        }
      }
      return null;
    }
    return null;
  }

  /** The length of a collection expression. */
  lengthOf(n: t.Node | null | undefined): Ref {
    if (!n) return null;
    // graph.get(node) ?? []: the left side is what's measured
    if (t.isLogicalExpression(n)) return this.lengthOf(n.left);
    if (t.isTSAsExpression(n) || t.isTSNonNullExpression(n) || t.isParenthesizedExpression(n)) return this.lengthOf(n.expression);
    if (t.isIdentifier(n)) {
      if (this.elements.has(n.name)) return { ...this.elements.get(n.name)!, inner: true };
      const alias = this.aliases.get(n.name);
      if (alias?.len) return alias;
      return { name: n.name, len: true };
    }
    if (t.isMemberExpression(n) && n.computed) {
      const base = dotted(n.object);
      if (!base) return null;
      const ref = t.isIdentifier(n.object) ? this.lengthOf(n.object) : { name: base, len: true };
      return ref && ref !== "const" ? { ...ref, inner: true } : null;
    }
    if (t.isMemberExpression(n)) {
      const base = dotted(n.object);
      if (base && t.isIdentifier(n.object) && !this.containers.has(n.object.name)) return { name: base, len: true, inner: true };
      const d = dotted(n);
      return d ? { name: d, len: true } : null;
    }
    if (t.isArrayExpression(n) || t.isObjectExpression(n) || isConst(n)) {
      if (t.isArrayExpression(n) && n.elements.length === 1 && t.isSpreadElement(n.elements[0])) return this.lengthOf(n.elements[0].argument);
      return "const";
    }
    if (t.isCallExpression(n) || t.isNewExpression(n)) {
      const name = callName(n);
      const d = t.isMemberExpression(n.callee) ? dotted(n.callee) : null;
      if (d && /^Object\.(keys|values|entries)$/.test(d) && n.arguments[0]) return this.lengthOf(n.arguments[0] as t.Node);
      if (d === "Array.from" && n.arguments[0]) {
        const a = n.arguments[0];
        if (t.isObjectExpression(a)) {
          const len = a.properties.find((p) => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === "length") as t.ObjectProperty | undefined;
          return len ? this.sizeOf(len.value as t.Node, true) : null;
        }
        return this.lengthOf(a as t.Node);
      }
      if (t.isMemberExpression(n.callee) && name && ["entries", "keys", "values", "slice", "split", "reverse", "sort", "toSorted", "toReversed", "map", "filter", "concat"].includes(name)) {
        if (name === "slice" && n.arguments.length === 2 && !n.arguments.some((a) => halves(a as t.Node) || [...namesIn(a as t.Node)].some((x) => this.mids.has(x)))) {
          const upper = this.sizeOf(n.arguments[1] as t.Node, true);
          if (upper && upper !== "const" && isConst(n.arguments[0] as t.Node)) return upper;
        }
        return this.lengthOf(n.callee.object);
      }
      if ((name === "Array" || d === "Array") && n.arguments.length === 1) return this.sizeOf(n.arguments[0] as t.Node, true);
      // graph.get(node): one item of a Map
      if (t.isMemberExpression(n.callee) && name === "get" && n.arguments.length === 1) {
        const base = this.lengthOf(n.callee.object);
        return base && base !== "const" ? { ...base, inner: true } : null;
      }
      if (t.isMemberExpression(n.callee) && name === "fill") return this.lengthOf(n.callee.object);
      if (t.isNewExpression(n) && name && /^(Set|Map)$/.test(name) && n.arguments[0]) return this.lengthOf(n.arguments[0] as t.Node);
      return this.sizeOf(n);
    }
    return null;
  }

  private looksLikeCollection(a: t.Node): boolean {
    if (t.isCallExpression(a) && callName(a) === "slice") return true;
    if (t.isIdentifier(a)) return this.containers.has(a.name) || this.elements.has(a.name) || (this.params.includes(a.name) && this.usedAsCollection(a.name));
    return false;
  }

  private usedAsCollection(name: string): boolean {
    let used = false;
    for (const root of this.body) shallow(root, (n) => {
      if (t.isMemberExpression(n) && t.isIdentifier(n.object) && n.object.name === name &&
        (n.computed || (t.isIdentifier(n.property) && /^(length|size|slice|push|forEach|map)$/.test(n.property.name)))) used = true;
      if (t.isForOfStatement(n) && t.isIdentifier(n.right) && n.right.name === name) used = true;
    });
    return used;
  }

  argRef(a: t.Node): SizeRef | null {
    if (t.isIdentifier(a)) {
      if (this.aliases.has(a.name)) return this.aliases.get(a.name)!;
      if (this.indexVars.has(a.name) || this.mids.has(a.name)) return null;
      return { name: a.name };
    }
    if (t.isMemberExpression(a) && !a.computed) {
      if (t.isIdentifier(a.property) && (a.property.name === "length" || a.property.name === "size")) {
        const r = this.lengthOf(a.object);
        return r && r !== "const" ? r : null;
      }
      const d = dotted(a);
      return d ? { name: d } : null;
    }
    if (t.isCallExpression(a) && t.isMemberExpression(a.callee) && callName(a) === "slice") return this.argRef(a.callee.object);
    if (t.isBinaryExpression(a)) return this.argRef(a.left as t.Node) ?? this.argRef(a.right);
    return null;
  }

  // -- loop bounds -----------------------------------------------------------

  forBound(n: t.ForOfStatement | t.ForInStatement | t.ForStatement): CostBound {
    if (t.isForOfStatement(n) || t.isForInStatement(n)) {
      const ref = this.lengthOf(n.right);
      const header = sourceOf(n.right);
      const targets: string[] = [];
      const left = t.isVariableDeclaration(n.left) ? n.left.declarations[0]?.id : n.left;
      if (left) t.traverseFast(left, (x) => { if (t.isIdentifier(x)) targets.push(x.name); });
      if (ref && ref !== "const" && !ref.inner && t.isForOfStatement(n)) {
        const base = this.collectionOf(n.right);
        if (base) for (const v of targets) this.elements.set(v, base);
      }
      if (ref === "const") return { kind: "const", why: header };
      return ref ? { kind: "size", sizes: [ref], why: header } : { kind: "unknown", why: header };
    }
    // for (init; test; update)
    const header = `for (${n.init ? sourceOf(n.init) : ""}; ${n.test ? sourceOf(n.test) : ""}; ${n.update ? sourceOf(n.update) : ""})`;
    const counters = new Map<string, "step" | "up" | "down">();
    const visitUpdate = (u: t.Node) => {
      if (t.isUpdateExpression(u) && t.isIdentifier(u.argument)) counters.set(u.argument.name, "step");
      else if (t.isAssignmentExpression(u) && t.isIdentifier(u.left)) {
        if (u.operator === "+=" || u.operator === "-=") counters.set(u.left.name, "step");
        else if (u.operator === "*=" || u.operator === "<<=") counters.set(u.left.name, "up");
        else if (u.operator === "/=" || u.operator === ">>=" || u.operator === ">>>=") counters.set(u.left.name, "down");
        else if (u.operator === "=" && halves(u.right)) counters.set(u.left.name, "down");
        else if (u.operator === "=" && t.isBinaryExpression(u.right) && u.right.operator === "*") counters.set(u.left.name, "up");
        else if (u.operator === "=" && t.isMemberExpression(u.right) && rootName(u.right) === u.left.name) counters.set(u.left.name, "step");
      } else if (t.isSequenceExpression(u)) u.expressions.forEach(visitUpdate);
    };
    if (n.update) visitUpdate(n.update);
    const starts = new Map<string, t.Node>();
    if (t.isVariableDeclaration(n.init)) for (const d of n.init.declarations) if (t.isIdentifier(d.id) && d.init) starts.set(d.id.name, d.init);
    if (t.isAssignmentExpression(n.init) && t.isIdentifier(n.init.left)) starts.set(n.init.left.name, n.init.right);
    // node = node.next style: a linked walk
    if (n.update && t.isAssignmentExpression(n.update) && t.isMemberExpression(n.update.right) && t.isIdentifier(n.update.left) &&
      !n.update.right.computed && rootName(n.update.right) === n.update.left.name) {
      const start = starts.get(n.update.left.name);
      const root = start && t.isIdentifier(start) ? this.structureRoot(start.name) : null;
      if (root) return { kind: "size", sizes: [{ name: root, len: true }], why: header };
    }
    const sizes: SizeRef[] = [];
    let kind: "size" | "log" = "size";
    if (n.test) {
      for (const [name, how] of counters) {
        const compares: t.BinaryExpression[] = [];
        t.traverseFast(n.test, (x) => { if (t.isBinaryExpression(x) && /^[<>]=?$|^!==?$/.test(x.operator)) compares.push(x); });
        for (const c of compares) {
          const sides = [c.left, c.right] as t.Node[];
          if (!sides.some((s) => t.isIdentifier(s) && s.name === name)) continue;
          for (const s of sides) {
            let ref: Ref;
            if (t.isIdentifier(s) && s.name === name) {
              const start = starts.get(name);
              ref = start ? this.sizeOf(start, true) : null;
            } else ref = isConst(s) ? null : this.sizeOf(s, true);
            if (ref && ref !== "const" && !sizes.some((x) => x.name === ref.name && x.len === ref.len)) sizes.push(ref);
          }
        }
        if (how !== "step") kind = "log";
      }
      for (const [name] of counters) this.indexVars.set(name, sizes[0] ?? null);
    }
    if (!sizes.length) {
      if (n.test && counters.size && [...namesIn(n.test)].every((x) => counters.has(x))) return { kind: "const", why: header };
      return { kind: "unknown", why: header };
    }
    return kind === "log" ? { kind: "log", size: sizes[0], why: header } : { kind: "size", sizes, why: header };
  }

  private collectionOf(right: t.Node): SizeRef | null {
    if (t.isCallExpression(right) && t.isMemberExpression(right.callee) && /^(entries|keys|values)$/.test(callName(right) ?? "")) {
      const d = dotted(right.callee);
      if (d && /^Object\./.test(d) && right.arguments[0]) return this.collectionOf(right.arguments[0] as t.Node);
      return this.collectionOf(right.callee.object);
    }
    if (t.isIdentifier(right)) {
      const alias = this.aliases.get(right.name);
      return alias?.len ? alias : { name: right.name, len: true };
    }
    return null;
  }

  whileBound(n: t.WhileStatement | t.DoWhileStatement): CostBound {
    const test = n.test;
    const header = `while (${sourceOf(test)})`;
    const testNames = namesIn(test);
    const changes = new Map<string, "log" | "follow" | "step">();
    shallow(n.body, (x) => {
      if (t.isUpdateExpression(x) && t.isIdentifier(x.argument)) { if (!changes.has(x.argument.name)) changes.set(x.argument.name, "step"); }
      else if (t.isAssignmentExpression(x) && t.isIdentifier(x.left)) {
        const name = x.left.name;
        const v = x.right;
        if (x.operator === "/=" || x.operator === ">>=" || x.operator === ">>>=" || x.operator === "*=" || x.operator === "<<=") changes.set(name, "log");
        else if (x.operator === "+=" || x.operator === "-=") { if (!changes.has(name)) changes.set(name, "step"); }
        else if (halves(v) || [...namesIn(v)].some((m) => this.mids.has(m))) changes.set(name, "log");
        else if (t.isMemberExpression(v) && !v.computed && rootName(v) === name) changes.set(name, "follow");
        else if (t.isIdentifier(v) && this.follows(v.name, name, n.body)) changes.set(name, "follow");
      }
    });
    const logs = [...changes].filter(([k, v]) => v === "log" && (testNames.has(k) || [...testNames].some((x) => this.mids.has(x)))).map(([k]) => k);
    if (logs.length) {
      const ref = this.testSize(test, new Set(logs));
      if (ref) return { kind: "log", size: ref, why: `${header} (halves each pass)` };
    }
    const follow = [...changes].find(([, v]) => v === "follow");
    if (follow) {
      const root = this.structureRoot(follow[0]);
      if (root) return { kind: "size", sizes: [{ name: root, len: true }], why: `${header} (follows links)` };
    }
    const steps = [...changes].filter(([k, v]) => v === "step" && testNames.has(k)).map(([k]) => k);
    if (steps.length) {
      const sizes: SizeRef[] = [];
      t.traverseFast(test, (c) => {
        if (!t.isBinaryExpression(c) || !/^[<>]=?$/.test(c.operator)) return;
        const sides = [c.left, c.right] as t.Node[];
        if (!sides.some((s) => t.isIdentifier(s) && steps.includes(s.name))) return;
        for (const s of sides) {
          let ref: Ref;
          if (t.isIdentifier(s) && steps.includes(s.name)) {
            const start = this.inits.get(s.name);
            ref = start ? this.sizeOf(start, true) : null;
          } else ref = isConst(s) ? null : this.sizeOf(s, true);
          if (ref && ref !== "const" && !sizes.some((x) => x.name === ref.name && x.len === ref.len)) sizes.push(ref);
        }
      });
      if (sizes.length) return { kind: "size", sizes, why: header };
    }
    return { kind: "unknown", why: header };
  }

  private follows(temp: string, name: string, body: t.Node): boolean {
    let yes = false;
    shallow(body, (x) => {
      if (t.isVariableDeclarator(x) && t.isIdentifier(x.id) && x.id.name === temp && x.init && t.isMemberExpression(x.init) && rootName(x.init) === name) yes = true;
      if (t.isAssignmentExpression(x) && t.isIdentifier(x.left) && x.left.name === temp && t.isMemberExpression(x.right) && rootName(x.right) === name) yes = true;
    });
    return yes;
  }

  private structureRoot(name: string): string | null {
    const seen = new Set<string>();
    while (!seen.has(name)) {
      seen.add(name);
      if (this.params.includes(name)) return name;
      const init = this.inits.get(name);
      if (init && t.isIdentifier(init)) { name = init.name; continue; }
      if (init && t.isMemberExpression(init)) return rootName(init);
      return name;
    }
    return name;
  }

  private testSize(test: t.Node, changing: Set<string>): SizeRef | null {
    const names = [...namesIn(test)];
    for (const n of names) if (this.aliases.has(n)) return this.aliases.get(n)!;
    for (const n of names) {
      const start = this.inits.get(n);
      const ref = start ? this.sizeOf(start, true) : null;
      if (ref && ref !== "const") return ref;
    }
    const others = names.filter((n) => !changing.has(n));
    return others[0] ? { name: others[0] } : names[0] ? { name: names[0] } : null;
  }

  // -- building --------------------------------------------------------------

  build(memo: boolean): CostFunction {
    return { name: this.name, line: this.line, params: this.params, memo, body: this.statements(this.body, false) };
  }

  statements(nodes: t.Node[], inLoop: boolean): CostNode[] {
    const out: CostNode[] = [];
    for (const s of nodes) out.push(...this.statement(s, inLoop));
    return out;
  }

  private statement(s: t.Node, inLoop: boolean): CostNode[] {
    if (t.isFunctionDeclaration(s) || t.isClassDeclaration(s) || t.isTSInterfaceDeclaration(s) || t.isTSTypeAliasDeclaration(s)) return [];
    if (t.isBlockStatement(s)) return this.statements(s.body, inLoop);
    if (t.isLabeledStatement(s)) return this.statement(s.body, inLoop);
    const loop = this.loopIds.get(s);
    if (t.isForOfStatement(s) || t.isForInStatement(s)) {
      const out = this.expr(s.right, inLoop);
      out.push({ kind: "loop", ...(loop ? { loop } : {}), line: line(s), bound: this.forBound(s), body: this.statement(s.body, true) });
      return out;
    }
    if (t.isForStatement(s)) {
      const out = s.init ? (t.isVariableDeclaration(s.init) ? this.declaration(s.init, inLoop) : this.expr(s.init, inLoop)) : [];
      const bound = this.forBound(s);
      const body = [...(s.test ? this.expr(s.test, true) : []), ...this.statement(s.body, true), ...(s.update ? this.expr(s.update, true) : [])];
      out.push({ kind: "loop", ...(loop ? { loop } : {}), line: line(s), bound, body });
      return out;
    }
    if (t.isWhileStatement(s) || t.isDoWhileStatement(s)) {
      const bound = this.whileBound(s);
      return [{ kind: "loop", ...(loop ? { loop } : {}), line: line(s), bound, body: [...this.expr(s.test, true), ...this.statement(s.body, true)] }];
    }
    if (t.isIfStatement(s)) return [...this.expr(s.test, inLoop), ...this.statement(s.consequent, inLoop), ...(s.alternate ? this.statement(s.alternate, inLoop) : [])];
    if (t.isTryStatement(s)) return [...this.statement(s.block, inLoop), ...(s.handler ? this.statement(s.handler.body, inLoop) : []), ...(s.finalizer ? this.statement(s.finalizer, inLoop) : [])];
    if (t.isSwitchStatement(s)) return [...this.expr(s.discriminant, inLoop), ...s.cases.flatMap((c) => this.statements(c.consequent, inLoop))];
    if (t.isVariableDeclaration(s)) return this.declaration(s, inLoop);
    if (t.isExpressionStatement(s)) return this.expr(s.expression, inLoop, true);
    if (t.isReturnStatement(s) && s.argument && t.isCallExpression(s.argument)) this.returned.add(s.argument);
    if (t.isReturnStatement(s) || t.isThrowStatement(s)) return s.argument ? this.expr(s.argument, inLoop) : [];
    return [];
  }

  private declaration(d: t.VariableDeclaration, inLoop: boolean): CostNode[] {
    const out: CostNode[] = [];
    for (const decl of d.declarations) {
      if (!decl.init) continue;
      out.push(...this.expr(decl.init, inLoop));
      const sizes = this.allocSizes(decl.init);
      if (sizes?.length) out.push({ kind: "alloc", line: line(decl), what: sourceOf(decl.init).slice(0, 40), sizes, ...(t.isIdentifier(decl.id) ? { name: decl.id.name } : {}) });
    }
    return out;
  }

  /** Sizes multiplied together, if value makes a new collection that big. */
  private allocSizes(v: t.Node): SizeRef[] | null {
    if (t.isNewExpression(v) || t.isCallExpression(v)) {
      const name = callName(v);
      const d = t.isMemberExpression(v.callee) ? dotted(v.callee) : null;
      if (d === "Array.from" && v.arguments[0]) {
        const first = v.arguments[0];
        const lengthProp = t.isObjectExpression(first)
          ? first.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === "length")
          : undefined;
        const outer = lengthProp ? this.sizeOf(lengthProp.value as t.Node, true) : this.lengthOf(first as t.Node);
        const body = returned(v.arguments[1]);
        const inner = body ? this.allocSizes(body) : null;
        return outer && outer !== "const" ? [outer, ...(inner ?? [])] : inner;
      }
      if (t.isMemberExpression(v.callee) && name && (name === "fill" || name === "map")) {
        const base = this.allocSizes(v.callee.object);
        const body = name === "map" ? returned(v.arguments[0]) : null;
        if (body) {
          const inner = this.allocSizes(body);
          return base || inner ? [...(base ?? []), ...(inner ?? [])] : null;
        }
        return base;
      }
      if ((name === "Array") && v.arguments.length === 1) {
        const r = this.sizeOf(v.arguments[0] as t.Node, true);
        return r && r !== "const" ? [r] : null;
      }
      if (t.isMemberExpression(v.callee) && name && COPY_METHODS.has(name)) {
        const r = this.lengthOf(v);
        return r && r !== "const" ? [r] : null;
      }
      if (t.isNewExpression(v) && name && /^(Set|Map)$/.test(name) && v.arguments[0]) {
        const r = this.lengthOf(v.arguments[0] as t.Node);
        return r && r !== "const" ? [r] : null;
      }
      return null;
    }
    if (t.isArrayExpression(v) && v.elements.some((e) => t.isSpreadElement(e))) {
      const refs = v.elements.filter((e): e is t.SpreadElement => t.isSpreadElement(e)).map((e) => this.lengthOf(e.argument)).filter((r): r is SizeRef => !!r && r !== "const");
      return refs.length ? [refs[0]] : null;
    }
    return null;
  }

  /** Calls, costly built-ins, callback loops and growth in an expression, in order. */
  expr(n: t.Node | null | undefined, inLoop: boolean, statement = false): CostNode[] {
    if (!n) return [];
    if (t.isFunction(n)) return [];
    const out: CostNode[] = [];
    if (t.isCallExpression(n) || t.isNewExpression(n)) {
      const name = callName(n);
      const member = t.isMemberExpression(n.callee) ? n.callee : null;
      const receiver = member ? dotted(member.object) : null;
      // arr.forEach(x => ...): a loop with the callback's body
      if (member && name && CALLBACK_LOOPS.has(name) && n.arguments[0] && !this.isUserMethodCall(n)) {
        out.push(...this.expr(member.object, inLoop));
        const cb = n.arguments[0];
        const ref = this.lengthOf(member.object);
        const bound: CostBound = ref === "const" ? { kind: "const", why: sourceOf(member.object) } : ref ? { kind: "size", sizes: [ref], why: `${sourceOf(member.object)}.${name}(...)` } : { kind: "unknown", why: `${name}(...)` };
        let body: CostNode[] = [];
        if (t.isArrowFunctionExpression(cb) || t.isFunctionExpression(cb)) {
          const params = cb.params.filter((p): p is t.Identifier => t.isIdentifier(p)).map((p) => p.name);
          if (params[0] && ref && ref !== "const") this.elements.set(params[0], this.collectionOf(member.object) ?? ref);
          body = t.isBlockStatement(cb.body) ? this.statements(cb.body.body, true) : this.expr(cb.body, true);
        } else body = this.expr(cb as t.Node, true);
        if (t.isIdentifier(cb) && this.userFunctions.has(cb.name)) body.push({ kind: "call", line: line(n), callee: this.userFunctions.get(cb.name)!, args: [], shrink: "same" });
        out.push({ kind: "loop", line: line(n), bound, body });
        return out;
      }
      for (const a of [n.callee, ...n.arguments]) out.push(...this.expr(a as t.Node, inLoop));
      out.push(...this.call(n, name, member, receiver));
      return out;
    }
    if (t.isBinaryExpression(n) && n.operator === "in") {
      out.push(...this.expr(n.left as t.Node, inLoop), ...this.expr(n.right, inLoop));
      return out; // key in object: a hash lookup
    }
    if (t.isAssignmentExpression(n)) {
      out.push(...this.expr(n.right, inLoop));
      if (t.isMemberExpression(n.left) && n.left.computed) {
        out.push(...this.expr(n.left.object, inLoop), ...this.expr(n.left.property as t.Node, inLoop));
        const base = t.isIdentifier(n.left.object) ? n.left.object.name : null;
        if (base && this.containers.get(base) === "dict") out.push({ kind: "alloc", line: line(n), what: `${base}[...] = ...`, sizes: [], into: base });
      }
      if (statement && t.isIdentifier(n.left)) {
        const sizes = this.allocSizes(n.right);
        if (sizes?.length) out.push({ kind: "alloc", line: line(n), what: sourceOf(n.right).slice(0, 40), sizes, name: n.left.name });
      }
      return out;
    }
    if (t.isSpreadElement(n)) {
      out.push(...this.expr(n.argument, inLoop));
      const r = this.lengthOf(n.argument);
      if (r && r !== "const") out.push({ kind: "op", line: line(n), what: `...${sourceOf(n.argument).slice(0, 20)} (copies)`, cost: "linear", size: r });
      return out;
    }
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
      const child = (n as unknown as Record<string, unknown>)[key];
      for (const c of Array.isArray(child) ? child : [child]) {
        if (c && typeof c === "object" && "type" in c) out.push(...this.expr(c as t.Node, inLoop));
      }
    }
    return out;
  }

  private isUserMethodCall(n: t.CallExpression | t.NewExpression): boolean {
    const member = t.isMemberExpression(n.callee) ? n.callee : null;
    const name = callName(n);
    return !!member && !!name && this.userFunctions.has(name) && (t.isThisExpression(member.object) || (t.isIdentifier(member.object) && !this.containers.has(member.object.name) && !this.elements.has(member.object.name) && !this.params.includes(member.object.name)));
  }

  private call(n: t.CallExpression | t.NewExpression, name: string | null, member: t.MemberExpression | null, receiver: string | null): CostNode[] {
    const l = line(n);
    if (!name) return [];
    if (t.isCallExpression(n) && this.userFunctions.has(name) && (!member || this.isUserMethodCall(n))) {
      const callee = this.userFunctions.get(name)!;
      const args = n.arguments.map((a) => this.argRef(a as t.Node));
      const shrink = callee === this.name ? this.shrink(n) : "same";
      return [{ kind: "call", line: l, callee, args, shrink, ...(this.returned.has(n) ? { alt: true } : {}) }];
    }
    if (member && !receiver && (name === "sort" || name === "toSorted")) {
      const r = this.lengthOf(member.object);
      return r && r !== "const" ? [{ kind: "op", line: l, what: `${name}()`, cost: "nlogn", size: r }] : [];
    }
    if (!member || !receiver) {
      const d = member ? dotted(member) : null;
      if (d && /^(Object\.(keys|values|entries)|Array\.from|JSON\.stringify)$/.test(d) && n.arguments[0]) {
        const r = this.lengthOf(n.arguments[0] as t.Node);
        if (r && r !== "const") return [{ kind: "op", line: l, what: `${d}()`, cost: "linear", size: r }];
      }
      return [];
    }
    const out: CostNode[] = [];
    const kind = this.containers.get(receiver);
    const r = this.lengthOf(member.object);
    if (name === "sort" || name === "toSorted") {
      if (r && r !== "const") out.push({ kind: "op", line: l, what: `${receiver}.${name}()`, cost: "nlogn", size: r });
    } else if (HASHED.has(name) && kind !== "list" && name !== "add" && name !== "set") {
      // Map/Set lookups are O(1)
    } else if (LINEAR_METHODS.has(name) && kind !== "dict" && kind !== "set") {
      if (r && r !== "const") out.push({ kind: "op", line: l, what: `${receiver}.${name}()${COPY_METHODS.has(name) ? " (copies)" : ""}`, cost: "linear", size: r, container: receiver });
    }
    if (GROW_METHODS.has(name)) out.push({ kind: "alloc", line: l, what: `${receiver}.${name}()`, sizes: [], into: receiver });
    return out;
  }

  private shrink(call: t.CallExpression): Shrink {
    const kinds: string[] = [];
    const pairs: [string, t.Node][] = [];
    call.arguments.forEach((a, i) => {
      const param = this.params[i];
      kinds.push(this.argShrink(a as t.Node, param));
      if (param) pairs.push([param, a as t.Node]);
    });
    this.recursive.push(pairs);
    for (const k of ["half", "child", "minus"] as const) if (kinds.includes(k)) return k;
    if (kinds.length && kinds.every((k) => k === "same" || k === "const")) return "same";
    return "unknown";
  }

  private argShrink(a: t.Node, param: string | undefined): string {
    if (isConst(a)) return "const";
    if (t.isIdentifier(a)) {
      if (a.name === param) return "same";
      if (this.mids.has(a.name)) return "half";
      if (this.elements.has(a.name) && this.elements.get(a.name)!.name === param) return "child";
      return "unknown";
    }
    if ([...namesIn(a)].some((n) => this.mids.has(n)) || halves(a)) return "half";
    if (t.isMemberExpression(a) && !a.computed) {
      const root = rootName(a);
      if (root && this.params.includes(root)) return "child";
    }
    if (t.isCallExpression(a) && callName(a) === "slice") {
      return a.arguments.some((x) => halves(x as t.Node) || [...namesIn(x as t.Node)].some((n) => this.mids.has(n))) ? "half" : "minus";
    }
    if (t.isBinaryExpression(a) && (a.operator === "+" || a.operator === "-") && isConst(a.right) && t.isIdentifier(a.left) && this.params.includes(a.left.name)) return "minus";
    return "unknown";
  }

  memoized(): boolean {
    if (this.isGlobal) return false;
    const checked = new Set<string>();
    const stored = new Set<string>();
    for (const root of this.body) shallow(root, (n) => {
      if (t.isIfStatement(n) && anyNode(n.consequent, (x) => t.isReturnStatement(x))) {
        t.traverseFast(n.test, (x) => {
          if (t.isCallExpression(x) && callName(x) === "has" && t.isMemberExpression(x.callee)) { const d = dotted(x.callee.object); if (d) checked.add(d); }
          if (t.isBinaryExpression(x) && x.operator === "in") { const d = dotted(x.right); if (d) checked.add(d); }
          if (t.isMemberExpression(x) && x.computed) { const d = dotted(x.object); if (d) checked.add(d); }
        });
      }
      if (t.isCallExpression(n) && callName(n) === "set" && t.isMemberExpression(n.callee)) { const d = dotted(n.callee.object); if (d) stored.add(d); }
      if (t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && n.left.computed) { const d = dotted(n.left.object); if (d) stored.add(d); }
    });
    return [...checked].some((c) => stored.has(c));
  }

  /** A parameter moved both ways (r + 1 and r - 1) is a search, not a shrink. */
  explores(): boolean {
    const moves = new Map<string, Set<string>>();
    for (const pairs of this.recursive) {
      for (const [param, a] of pairs) {
        if (t.isBinaryExpression(a) && t.isIdentifier(a.left) && a.left.name === param && isConst(a.right)) {
          const set = moves.get(param) ?? new Set();
          set.add(a.operator);
          moves.set(param, set);
        }
      }
    }
    return [...moves.values()].some((s) => s.size > 1);
  }
}

/** What a one-line callback returns: `() => x`, or `() => { return x; }`. */
function returned(fn: t.Node | undefined): t.Node | null {
  if (!fn || !(t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn))) return null;
  if (!t.isBlockStatement(fn.body)) return fn.body;
  const only = fn.body.body.length === 1 ? fn.body.body[0] : null;
  return only && t.isReturnStatement(only) ? only.argument ?? null : null;
}

let currentSource = "";
const line = (n: t.Node) => n.loc?.start.line ?? 0;
const sourceOf = (n: t.Node) => (n.start != null && n.end != null ? currentSource.slice(n.start, n.end) : "").replace(/\s+/g, " ");

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
export function costAnalysis(ast: t.File, source: string, names: Map<t.Node, string>, loopIds: Map<t.Node, string>): CostInfo {
  currentSource = source;
  const userFunctions = new Map<string, string>(); // short name -> frame name
  const fns: [t.Function, string][] = [];
  traverse(ast, {
    Function(path: NodePath<t.Function>) {
      const name = names.get(path.node);
      if (!name || name === "anonymous" || !path.node.loc) return;
      // Callbacks passed inline are part of the loop they're in, not functions of their own.
      if ((t.isArrowFunctionExpression(path.node) || t.isFunctionExpression(path.node)) && t.isCallExpression(path.parent)) return;
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
    if (shape.explores()) iterCalls(built.body, (c) => { if (c.callee === name) c.shrink = "unknown"; });
    functions.push(built);
  }
  return { functions };
}
