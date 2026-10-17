/**
 * The sizes in a function: what each name and expression measures (a
 * parameter, a collection's length, an item of a collection). The first part
 * of the complexity estimate; loops.ts and shape.ts build on it.
 */
import * as t from "@babel/types";
import type { SizeRef } from "../../trace/types";
import { BUILTIN_CALLS, isBuiltinCall, METHODS, SIZE_PRESERVING_MATH } from "./builtins";
import { CONTAINER_CONSTRUCTORS } from "./maps";
import { anyNode, callName, dotted, halves, isConst, namesIn, type Ref, shallow } from "./syntax";

export class Sizes {
  aliases = new Map<string, SizeRef>();
  indexVars = new Map<string, SizeRef | null>();
  elements = new Map<string, SizeRef>();
  mids = new Set<string>();
  containers = new Map<string, "list" | "dict" | "set">();
  inits = new Map<string, t.Node>();

  constructor(
    readonly name: string,
    readonly line: number,
    readonly params: string[],
    readonly body: t.Node[],
    readonly userFunctions: Map<string, string>,
    readonly isGlobal: boolean,
    readonly loopIds: Map<t.Node, string>,
  ) {}

  protected learnAll(): void {
    for (const root of this.body)
      shallow(root, (n) => {
        if (t.isVariableDeclarator(n) && n.init) this.learn(n.id, n.init);
        else if (t.isAssignmentExpression(n) && n.operator === "=") this.learn(n.left, n.right);
      });
  }

  private learn(target: t.Node, value: t.Node): void {
    if (t.isArrayPattern(target) && t.isArrayExpression(value) && target.elements.length === value.elements.length) {
      target.elements.forEach((el, i) => {
        if (el && value.elements[i]) this.learn(el, value.elements[i]!);
      });
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
      const copy =
        t.isArrayExpression(value) || t.isCallExpression(value) || t.isNewExpression(value)
          ? this.lengthOf(value)
          : null;
      const ref = this.sizeOf(value, true) ?? (copy && copy !== "const" ? copy : null);
      if (ref && ref !== "const" && ref.name !== name) this.aliases.set(name, ref);
    }
  }

  private containerKind(v: t.Node): "list" | "dict" | "set" | null {
    if (t.isArrayExpression(v)) return "list";
    if (t.isObjectExpression(v)) return "dict";
    if (t.isNewExpression(v) && t.isIdentifier(v.callee) && Object.hasOwn(CONTAINER_CONSTRUCTORS, v.callee.name))
      return CONTAINER_CONSTRUCTORS[v.callee.name];
    return null;
  }

  /** The size an expression measures. */
  sizeOf(n: t.Node | null | undefined, allowValue = false): Ref {
    if (!n) return null;
    if (isConst(n)) return "const";
    if (t.isTSAsExpression(n) || t.isTSNonNullExpression(n) || t.isParenthesizedExpression(n))
      return this.sizeOf(n.expression, allowValue);
    if (
      t.isMemberExpression(n) &&
      !n.computed &&
      t.isIdentifier(n.property) &&
      (n.property.name === "length" || n.property.name === "size")
    ) {
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
        const plain = sides.filter(
          (r, i) =>
            r &&
            r !== "const" &&
            !(t.isIdentifier([n.left, n.right][i]) && this.indexVars.has(([n.left, n.right][i] as t.Identifier).name)),
        ) as SizeRef[];
        return plain[0] ?? refs[0];
      }
      return sides.every((r) => r === "const") ? "const" : null;
    }
    if (t.isUnaryExpression(n)) return this.sizeOf(n.argument, allowValue);
    if (t.isCallExpression(n)) {
      const name = callName(n);
      const d = t.isMemberExpression(n.callee) ? dotted(n.callee) : null;
      if (d && SIZE_PRESERVING_MATH.has(d)) {
        for (const a of n.arguments) {
          const r = this.sizeOf(a as t.Node, allowValue);
          if (r && r !== "const") return r;
        }
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
    if (t.isTSAsExpression(n) || t.isTSNonNullExpression(n) || t.isParenthesizedExpression(n))
      return this.lengthOf(n.expression);
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
      if (base && t.isIdentifier(n.object) && !this.containers.has(n.object.name))
        return { name: base, len: true, inner: true };
      const d = dotted(n);
      return d ? { name: d, len: true } : null;
    }
    if (t.isArrayExpression(n) || t.isObjectExpression(n) || isConst(n)) {
      if (t.isArrayExpression(n) && n.elements.length === 1 && t.isSpreadElement(n.elements[0]))
        return this.lengthOf(n.elements[0].argument);
      return "const";
    }
    if (t.isCallExpression(n) || t.isNewExpression(n)) {
      const name = callName(n);
      const d = t.isMemberExpression(n.callee) ? dotted(n.callee) : null;
      if (isBuiltinCall(d) && BUILTIN_CALLS[d].sameLength && n.arguments[0])
        return this.lengthOf(n.arguments[0] as t.Node);
      if (d === "Array.from" && n.arguments[0]) {
        const a = n.arguments[0];
        if (t.isObjectExpression(a)) {
          const len = a.properties.find(
            (p) => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === "length",
          ) as t.ObjectProperty | undefined;
          return len ? this.sizeOf(len.value as t.Node, true) : null;
        }
        return this.lengthOf(a as t.Node);
      }
      if (t.isMemberExpression(n.callee) && name && METHODS.get(name)?.sameLength) {
        if (
          name === "slice" &&
          n.arguments.length === 2 &&
          !n.arguments.some((a) => halves(a as t.Node) || [...namesIn(a as t.Node)].some((x) => this.mids.has(x)))
        ) {
          const upper = this.sizeOf(n.arguments[1] as t.Node, true);
          if (upper && upper !== "const" && isConst(n.arguments[0] as t.Node)) return upper;
        }
        return this.lengthOf(n.callee.object);
      }
      if ((name === "Array" || d === "Array") && n.arguments.length === 1)
        return this.sizeOf(n.arguments[0] as t.Node, true);
      // graph.get(node): one item of a Map
      if (t.isMemberExpression(n.callee) && name === "get" && n.arguments.length === 1) {
        const base = this.lengthOf(n.callee.object);
        return base && base !== "const" ? { ...base, inner: true } : null;
      }
      if (t.isNewExpression(n) && name && /^(Set|Map)$/.test(name) && n.arguments[0])
        return this.lengthOf(n.arguments[0] as t.Node);
      return this.sizeOf(n);
    }
    return null;
  }

  private looksLikeCollection(a: t.Node): boolean {
    if (t.isCallExpression(a) && callName(a) === "slice") return true;
    if (t.isIdentifier(a))
      return (
        this.containers.has(a.name) ||
        this.elements.has(a.name) ||
        (this.params.includes(a.name) && this.usedAsCollection(a.name))
      );
    return false;
  }

  private usedAsCollection(name: string): boolean {
    let used = false;
    for (const root of this.body)
      shallow(root, (n) => {
        if (
          t.isMemberExpression(n) &&
          t.isIdentifier(n.object) &&
          n.object.name === name &&
          (n.computed || (t.isIdentifier(n.property) && /^(length|size|slice|push|forEach|map)$/.test(n.property.name)))
        )
          used = true;
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
    if (t.isCallExpression(a) && t.isMemberExpression(a.callee) && callName(a) === "slice")
      return this.argRef(a.callee.object);
    if (t.isBinaryExpression(a)) return this.argRef(a.left as t.Node) ?? this.argRef(a.right);
    return null;
  }

  protected collectionOf(right: t.Node): SizeRef | null {
    if (
      t.isCallExpression(right) &&
      t.isMemberExpression(right.callee) &&
      /^(entries|keys|values)$/.test(callName(right) ?? "")
    ) {
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
}
