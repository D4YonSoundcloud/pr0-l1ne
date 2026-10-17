/**
 * A function's shape for the complexity estimate: its loops, calls and costly
 * built-ins in order (a CostFunction), on top of the sizes (sizes.ts) and loop
 * bounds (loops.ts) it reads. What each built-in costs is in the tables:
 * arrays.ts, strings.ts, maps.ts, builtins.ts.
 */
import * as t from "@babel/types";
import type { CostBound, CostFunction, CostNode, Shrink, SizeRef } from "../../trace/types";
import { METHODS } from "./builtins";
import { LoopBounds } from "./loops";
import {
  anyNode,
  callName,
  dotted,
  halves,
  isConst,
  line,
  namesIn,
  returned,
  rootName,
  shallow,
  sourceOf,
} from "./syntax";

export class Shape extends LoopBounds {
  /** Calls that are the whole of a return: only one of them runs per call. */
  returned = new Set<t.Node>();
  recursive: [string, t.Node][][] = [];

  constructor(
    name: string,
    line: number,
    params: string[],
    body: t.Node[],
    userFunctions: Map<string, string>,
    isGlobal: boolean,
    loopIds: Map<t.Node, string>,
  ) {
    super(name, line, params, body, userFunctions, isGlobal, loopIds);
    this.learnAll();
    for (const root of body)
      shallow(root, (n) => {
        if (t.isForOfStatement(n) || t.isForInStatement(n) || t.isForStatement(n)) this.forBound(n);
      });
    this.aliases.clear();
    this.inits.clear();
    this.learnAll();
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
    if (
      t.isFunctionDeclaration(s) ||
      t.isClassDeclaration(s) ||
      t.isTSInterfaceDeclaration(s) ||
      t.isTSTypeAliasDeclaration(s)
    )
      return [];
    if (t.isBlockStatement(s)) return this.statements(s.body, inLoop);
    if (t.isLabeledStatement(s)) return this.statement(s.body, inLoop);
    const loop = this.loopIds.get(s);
    if (t.isForOfStatement(s) || t.isForInStatement(s)) {
      const out = this.expr(s.right, inLoop);
      out.push({
        kind: "loop",
        ...(loop ? { loop } : {}),
        line: line(s),
        bound: this.forBound(s),
        body: this.statement(s.body, true),
      });
      return out;
    }
    if (t.isForStatement(s)) {
      const out = s.init
        ? t.isVariableDeclaration(s.init)
          ? this.declaration(s.init, inLoop)
          : this.expr(s.init, inLoop)
        : [];
      const bound = this.forBound(s);
      const body = [
        ...(s.test ? this.expr(s.test, true) : []),
        ...this.statement(s.body, true),
        ...(s.update ? this.expr(s.update, true) : []),
      ];
      out.push({ kind: "loop", ...(loop ? { loop } : {}), line: line(s), bound, body });
      return out;
    }
    if (t.isWhileStatement(s) || t.isDoWhileStatement(s)) {
      const bound = this.whileBound(s);
      return [
        {
          kind: "loop",
          ...(loop ? { loop } : {}),
          line: line(s),
          bound,
          body: [...this.expr(s.test, true), ...this.statement(s.body, true)],
        },
      ];
    }
    if (t.isIfStatement(s))
      return [
        ...this.expr(s.test, inLoop),
        ...this.statement(s.consequent, inLoop),
        ...(s.alternate ? this.statement(s.alternate, inLoop) : []),
      ];
    if (t.isTryStatement(s))
      return [
        ...this.statement(s.block, inLoop),
        ...(s.handler ? this.statement(s.handler.body, inLoop) : []),
        ...(s.finalizer ? this.statement(s.finalizer, inLoop) : []),
      ];
    if (t.isSwitchStatement(s))
      return [...this.expr(s.discriminant, inLoop), ...s.cases.flatMap((c) => this.statements(c.consequent, inLoop))];
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
      if (sizes?.length)
        out.push({
          kind: "alloc",
          line: line(decl),
          what: sourceOf(decl.init).slice(0, 40),
          sizes,
          ...(t.isIdentifier(decl.id) ? { name: decl.id.name } : {}),
        });
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
          ? first.properties.find(
              (p): p is t.ObjectProperty => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === "length",
            )
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
      if (name === "Array" && v.arguments.length === 1) {
        const r = this.sizeOf(v.arguments[0] as t.Node, true);
        return r && r !== "const" ? [r] : null;
      }
      if (t.isMemberExpression(v.callee) && name && METHODS.get(name)?.copies) {
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
      const refs = v.elements
        .filter((e): e is t.SpreadElement => t.isSpreadElement(e))
        .map((e) => this.lengthOf(e.argument))
        .filter((r): r is SizeRef => !!r && r !== "const");
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
      if (member && name && METHODS.get(name)?.cost === "loop" && n.arguments[0] && !this.isUserMethodCall(n)) {
        out.push(...this.expr(member.object, inLoop));
        const cb = n.arguments[0];
        const ref = this.lengthOf(member.object);
        const bound: CostBound =
          ref === "const"
            ? { kind: "const", why: sourceOf(member.object) }
            : ref
              ? { kind: "size", sizes: [ref], why: `${sourceOf(member.object)}.${name}(...)` }
              : { kind: "unknown", why: `${name}(...)` };
        let body: CostNode[] = [];
        if (t.isArrowFunctionExpression(cb) || t.isFunctionExpression(cb)) {
          const params = cb.params.filter((p): p is t.Identifier => t.isIdentifier(p)).map((p) => p.name);
          if (params[0] && ref && ref !== "const")
            this.elements.set(params[0], this.collectionOf(member.object) ?? ref);
          body = t.isBlockStatement(cb.body) ? this.statements(cb.body.body, true) : this.expr(cb.body, true);
        } else body = this.expr(cb as t.Node, true);
        if (t.isIdentifier(cb) && this.userFunctions.has(cb.name))
          body.push({
            kind: "call",
            line: line(n),
            callee: this.userFunctions.get(cb.name)!,
            args: [],
            shrink: "same",
          });
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
        if (base && this.containers.get(base) === "dict")
          out.push({ kind: "alloc", line: line(n), what: `${base}[...] = ...`, sizes: [], into: base });
      }
      if (statement && t.isIdentifier(n.left)) {
        const sizes = this.allocSizes(n.right);
        if (sizes?.length)
          out.push({ kind: "alloc", line: line(n), what: sourceOf(n.right).slice(0, 40), sizes, name: n.left.name });
      }
      return out;
    }
    if (t.isSpreadElement(n)) {
      out.push(...this.expr(n.argument, inLoop));
      const r = this.lengthOf(n.argument);
      if (r && r !== "const")
        out.push({
          kind: "op",
          line: line(n),
          what: `...${sourceOf(n.argument).slice(0, 20)} (copies)`,
          cost: "linear",
          size: r,
        });
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
    return (
      !!member &&
      !!name &&
      this.userFunctions.has(name) &&
      (t.isThisExpression(member.object) ||
        (t.isIdentifier(member.object) &&
          !this.containers.has(member.object.name) &&
          !this.elements.has(member.object.name) &&
          !this.params.includes(member.object.name)))
    );
  }

  private call(
    n: t.CallExpression | t.NewExpression,
    name: string | null,
    member: t.MemberExpression | null,
    receiver: string | null,
  ): CostNode[] {
    const l = line(n);
    if (!name) return [];
    if (t.isCallExpression(n) && this.userFunctions.has(name) && (!member || this.isUserMethodCall(n))) {
      const callee = this.userFunctions.get(name)!;
      const args = n.arguments.map((a) => this.argRef(a as t.Node));
      const shrink = callee === this.name ? this.shrink(n) : "same";
      return [{ kind: "call", line: l, callee, args, shrink, ...(this.returned.has(n) ? { alt: true } : {}) }];
    }
    const method = METHODS.get(name);
    if (member && !receiver && method?.cost === "nlogn") {
      const r = this.lengthOf(member.object);
      return r && r !== "const" ? [{ kind: "op", line: l, what: `${name}()`, cost: "nlogn", size: r }] : [];
    }
    if (!member || !receiver) return [];
    const out: CostNode[] = [];
    const kind = this.containers.get(receiver);
    const r = this.lengthOf(member.object);
    if (method?.cost === "nlogn") {
      if (r && r !== "const") out.push({ kind: "op", line: l, what: `${receiver}.${name}()`, cost: "nlogn", size: r });
    } else if (method?.cost === "linear" && kind !== "dict" && kind !== "set") {
      // (A Map or Set's methods are hashed: constant time.)
      if (r && r !== "const")
        out.push({
          kind: "op",
          line: l,
          what: `${receiver}.${name}()${method.copies ? " (copies)" : ""}`,
          cost: "linear",
          size: r,
          container: receiver,
        });
    }
    if (method?.grows) out.push({ kind: "alloc", line: l, what: `${receiver}.${name}()`, sizes: [], into: receiver });
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
      return a.arguments.some((x) => halves(x as t.Node) || [...namesIn(x as t.Node)].some((n) => this.mids.has(n)))
        ? "half"
        : "minus";
    }
    if (
      t.isBinaryExpression(a) &&
      (a.operator === "+" || a.operator === "-") &&
      isConst(a.right) &&
      t.isIdentifier(a.left) &&
      this.params.includes(a.left.name)
    )
      return "minus";
    return "unknown";
  }

  memoized(): boolean {
    if (this.isGlobal) return false;
    const checked = new Set<string>();
    const stored = new Set<string>();
    for (const root of this.body)
      shallow(root, (n) => {
        if (t.isIfStatement(n) && anyNode(n.consequent, (x) => t.isReturnStatement(x))) {
          t.traverseFast(n.test, (x) => {
            if (t.isCallExpression(x) && callName(x) === "has" && t.isMemberExpression(x.callee)) {
              const d = dotted(x.callee.object);
              if (d) checked.add(d);
            }
            if (t.isBinaryExpression(x) && x.operator === "in") {
              const d = dotted(x.right);
              if (d) checked.add(d);
            }
            if (t.isMemberExpression(x) && x.computed) {
              const d = dotted(x.object);
              if (d) checked.add(d);
            }
          });
        }
        if (t.isCallExpression(n) && callName(n) === "set" && t.isMemberExpression(n.callee)) {
          const d = dotted(n.callee.object);
          if (d) stored.add(d);
        }
        if (t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && n.left.computed) {
          const d = dotted(n.left.object);
          if (d) stored.add(d);
        }
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
