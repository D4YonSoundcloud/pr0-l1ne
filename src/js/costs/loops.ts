/** How many passes each loop makes, from its header (and, for while loops, its body). */
import * as t from "@babel/types";
import type { CostBound, SizeRef } from "../../trace/types";
import { Sizes } from "./sizes";
import { halves, isConst, namesIn, type Ref, rootName, shallow, sourceOf } from "./syntax";

export class LoopBounds extends Sizes {
  forBound(n: t.ForOfStatement | t.ForInStatement | t.ForStatement): CostBound {
    if (t.isForOfStatement(n) || t.isForInStatement(n)) {
      const ref = this.lengthOf(n.right);
      const header = sourceOf(n.right);
      const targets: string[] = [];
      const left = t.isVariableDeclaration(n.left) ? n.left.declarations[0]?.id : n.left;
      if (left)
        t.traverseFast(left, (x) => {
          if (t.isIdentifier(x)) targets.push(x.name);
        });
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
        else if (u.operator === "/=" || u.operator === ">>=" || u.operator === ">>>=")
          counters.set(u.left.name, "down");
        else if (u.operator === "=" && halves(u.right)) counters.set(u.left.name, "down");
        else if (u.operator === "=" && t.isBinaryExpression(u.right) && u.right.operator === "*")
          counters.set(u.left.name, "up");
        else if (u.operator === "=" && t.isMemberExpression(u.right) && rootName(u.right) === u.left.name)
          counters.set(u.left.name, "step");
      } else if (t.isSequenceExpression(u)) u.expressions.forEach(visitUpdate);
    };
    if (n.update) visitUpdate(n.update);
    const starts = new Map<string, t.Node>();
    if (t.isVariableDeclaration(n.init))
      for (const d of n.init.declarations) if (t.isIdentifier(d.id) && d.init) starts.set(d.id.name, d.init);
    if (t.isAssignmentExpression(n.init) && t.isIdentifier(n.init.left)) starts.set(n.init.left.name, n.init.right);
    // node = node.next style: a linked walk
    if (
      n.update &&
      t.isAssignmentExpression(n.update) &&
      t.isMemberExpression(n.update.right) &&
      t.isIdentifier(n.update.left) &&
      !n.update.right.computed &&
      rootName(n.update.right) === n.update.left.name
    ) {
      const start = starts.get(n.update.left.name);
      const root = start && t.isIdentifier(start) ? this.structureRoot(start.name) : null;
      if (root) return { kind: "size", sizes: [{ name: root, len: true }], why: header };
    }
    const sizes: SizeRef[] = [];
    let kind: "size" | "log" = "size";
    if (n.test) {
      for (const [name, how] of counters) {
        const compares: t.BinaryExpression[] = [];
        t.traverseFast(n.test, (x) => {
          if (t.isBinaryExpression(x) && /^[<>]=?$|^!==?$/.test(x.operator)) compares.push(x);
        });
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
      if (n.test && counters.size && [...namesIn(n.test)].every((x) => counters.has(x)))
        return { kind: "const", why: header };
      return { kind: "unknown", why: header };
    }
    return kind === "log" ? { kind: "log", size: sizes[0], why: header } : { kind: "size", sizes, why: header };
  }

  whileBound(n: t.WhileStatement | t.DoWhileStatement): CostBound {
    const test = n.test;
    const header = `while (${sourceOf(test)})`;
    const testNames = namesIn(test);
    const changes = new Map<string, "log" | "follow" | "step">();
    shallow(n.body, (x) => {
      if (t.isUpdateExpression(x) && t.isIdentifier(x.argument)) {
        if (!changes.has(x.argument.name)) changes.set(x.argument.name, "step");
      } else if (t.isAssignmentExpression(x) && t.isIdentifier(x.left)) {
        const name = x.left.name;
        const v = x.right;
        if (
          x.operator === "/=" ||
          x.operator === ">>=" ||
          x.operator === ">>>=" ||
          x.operator === "*=" ||
          x.operator === "<<="
        )
          changes.set(name, "log");
        else if (x.operator === "+=" || x.operator === "-=") {
          if (!changes.has(name)) changes.set(name, "step");
        } else if (halves(v) || [...namesIn(v)].some((m) => this.mids.has(m))) changes.set(name, "log");
        else if (t.isMemberExpression(v) && !v.computed && rootName(v) === name) changes.set(name, "follow");
        else if (t.isIdentifier(v) && this.follows(v.name, name, n.body)) changes.set(name, "follow");
      }
    });
    const logs = [...changes]
      .filter(([k, v]) => v === "log" && (testNames.has(k) || [...testNames].some((x) => this.mids.has(x))))
      .map(([k]) => k);
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

  protected follows(temp: string, name: string, body: t.Node): boolean {
    let yes = false;
    shallow(body, (x) => {
      if (
        t.isVariableDeclarator(x) &&
        t.isIdentifier(x.id) &&
        x.id.name === temp &&
        x.init &&
        t.isMemberExpression(x.init) &&
        rootName(x.init) === name
      )
        yes = true;
      if (
        t.isAssignmentExpression(x) &&
        t.isIdentifier(x.left) &&
        x.left.name === temp &&
        t.isMemberExpression(x.right) &&
        rootName(x.right) === name
      )
        yes = true;
    });
    return yes;
  }

  protected structureRoot(name: string): string | null {
    const seen = new Set<string>();
    while (!seen.has(name)) {
      seen.add(name);
      if (this.params.includes(name)) return name;
      const init = this.inits.get(name);
      if (init && t.isIdentifier(init)) {
        name = init.name;
        continue;
      }
      if (init && t.isMemberExpression(init)) return rootName(init);
      return name;
    }
    return name;
  }

  protected testSize(test: t.Node, changing: Set<string>): SizeRef | null {
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
}
