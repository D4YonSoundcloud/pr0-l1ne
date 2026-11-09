/**
 * Marks: the program says which objects it may have changed, so the tracer
 * reads only those at the next step (js/inspector.ts Serializer) and keeps
 * what it had for the rest. Without marks, every object is read at every
 * step to find the few that changed: most of the tracer's time on programs
 * that build big structures.
 *
 * A pass over the program, after it's analyzed and before the runtime's
 * calls go in (instrument.ts). Each write to an object, and each call that
 * could change what it's called on or given, is bracketed:
 *
 *   o.a = v                 __av.af(f, __av.bg(f), __av.w(f, o).a = v)
 *   a.push(x)               __av.af(f, __av.bg(f), __av.w(f, a).push(__av.w(f, x)))
 *
 * `w` notes an object as being written (it's read as changed from then
 * on), `af` marks it once the write or call is done (so a step recorded
 * while the right-hand side runs, or inside a sort's comparator, sees it as
 * it is then, and the next step sees what it became). `f` is the frame the
 * expression runs in: what's under way is kept with it, so a write across
 * an `await` or a `yield` is still done when it lands (runtime.ts).
 *
 * What's bracketed:
 *   - assignments to a field or an element, any operator, and fields or
 *     elements as destructuring targets: the object they're on;
 *   - ++ and -- on one, and `delete`: the same;
 *   - calls and `new`, except to the program's own functions and classes
 *     (whose writes are bracketed where they're made) and to the console:
 *     what it's called on and every argument that can be an object. No
 *     list of which built-ins change things is needed, or trusted: any of
 *     them might, so all of them count.
 *
 * What marks can't follow makes the whole run read every object instead
 * (Instrumented.unsafe): `eval`, `Function` (by name), `with`, and a field
 * as a for-in or for-of loop's target. Anything else that gets past them is
 * the in-run check's to catch (runtime.ts CHECK_EVERY), and the write
 * catalogue's to prevent (writeCatalogue.ts).
 */
import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { FRAME, RUNTIME } from "./transform";

/** Globals whose methods never change the object they're called on (Math.max doesn't change Math). */
const NAMESPACES = new Set([
  "Math",
  "JSON",
  "Number",
  "String",
  "Object",
  "Array",
  "Reflect",
  "Promise",
  "Symbol",
  "BigInt",
  "Boolean",
  "Atomics",
  "Intl",
]);

/** Global functions that don't change anything they aren't given (parseInt(s), setTimeout(fn)). */
const PLAIN_GLOBALS = new Set([
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "Number",
  "String",
  "Boolean",
  "BigInt",
  "Symbol",
  "Array",
  "Object",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "structuredClone",
  "encodeURIComponent",
  "decodeURIComponent",
  "require",
]);

const call = (method: string, args: t.Expression[]) =>
  t.callExpression(t.memberExpression(t.identifier(RUNTIME), t.identifier(method)), [t.identifier(FRAME), ...args]);

/** A call the runtime's own (__av.x(...)), never bracketed. */
function isRuntimeCall(node: t.Node): boolean {
  if (!t.isCallExpression(node)) return false;
  const callee = node.callee;
  return t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name.startsWith(RUNTIME);
}

/** Can this expression only ever be a primitive (so it's nothing to mark)? */
function primitive(e: t.Node): boolean {
  if (
    t.isNumericLiteral(e) ||
    t.isStringLiteral(e) ||
    t.isBooleanLiteral(e) ||
    t.isNullLiteral(e) ||
    t.isBigIntLiteral(e) ||
    t.isTemplateLiteral(e) ||
    t.isUnaryExpression(e) ||
    t.isBinaryExpression(e) ||
    t.isUpdateExpression(e)
  )
    return true;
  if (t.isLogicalExpression(e)) return primitive(e.left) && primitive(e.right);
  if (t.isConditionalExpression(e)) return primitive(e.consequent) && primitive(e.alternate);
  if (t.isSequenceExpression(e)) return primitive(e.expressions[e.expressions.length - 1]);
  if (t.isAssignmentExpression(e)) return e.operator !== "=" || primitive(e.right);
  return false;
}

/** A new object written right there ({...}, [...], a function): it can't have been read before, so there's nothing to mark. */
function fresh(e: t.Node): boolean {
  return (
    t.isObjectExpression(e) ||
    t.isArrayExpression(e) ||
    t.isFunctionExpression(e) ||
    t.isArrowFunctionExpression(e) ||
    t.isClassExpression(e) ||
    t.isRegExpLiteral(e)
  );
}

/** The member expressions a destructuring target writes to (fields and elements). */
function memberTargets(target: t.Node, out: t.MemberExpression[] = []): t.MemberExpression[] {
  if (t.isMemberExpression(target)) out.push(target);
  else if (t.isArrayPattern(target)) for (const el of target.elements) el && memberTargets(el, out);
  else if (t.isObjectPattern(target))
    for (const prop of target.properties) memberTargets(t.isRestElement(prop) ? prop.argument : prop.value, out);
  else if (t.isRestElement(target)) memberTargets(target.argument, out);
  else if (t.isAssignmentPattern(target)) memberTargets(target.left, out);
  return out;
}

/**
 * Bracket the program's writes and calls (see the top of this file). Returns
 * why marks can't follow it, if they can't: the run then reads everything.
 */
export function markWrites(ast: t.File): string | undefined {
  let unsafe: string | undefined;
  const noteUnsafe = (why: string) => {
    unsafe ??= why;
  };
  /** Expressions this pass made (its brackets), not to be bracketed again. */
  const made = new WeakSet<t.Node>();

  /** `object` as written: noted with w (super: `this`, noted beside the expression instead). */
  const writing = (member: t.MemberExpression | t.OptionalMemberExpression, thisToo: { needed: boolean }) => {
    if (t.isSuper(member.object)) thisToo.needed = true;
    else member.object = call("w", [member.object as t.Expression]);
  };

  /** expr, done: af(f, bg(f), expr), with `this` noted first when a super write or call needs it. */
  const bracket = (expr: t.Expression, thisToo: boolean): t.Expression => {
    const inner = thisToo ? t.sequenceExpression([call("w", [t.thisExpression()]), expr]) : expr;
    const out = call("af", [call("bg", []), inner]);
    made.add(out);
    return out;
  };

  /** The whole optional chain a call is part of (o?.a.b(x).c): bracketed whole, or the chain would break. */
  const chainRoot = (path: NodePath): NodePath => {
    let at = path;
    for (;;) {
      const parent = at.parentPath;
      if (parent?.isOptionalMemberExpression() && parent.node.object === at.node) at = parent;
      else if (parent?.isOptionalCallExpression() && parent.node.callee === at.node) at = parent;
      else return at;
    }
  };
  /** Chains to bracket when their outermost node is done (and whether `this` needs noting too). */
  const chains = new Map<t.Node, boolean>();

  /** Is this a call to the program's own function or class (bracketed where it writes)? */
  const ownCallee = (callee: t.Node, path: NodePath): boolean => {
    if (!t.isIdentifier(callee)) return false;
    const binding = path.scope.getBinding(callee.name);
    if (!binding) return false;
    if (binding.kind === "hoisted") return true; // a function declaration
    if (!binding.constant) return false;
    const decl = binding.path.node;
    if (t.isClassDeclaration(decl)) return true;
    if (t.isVariableDeclarator(decl))
      return (
        t.isFunctionExpression(decl.init) || t.isArrowFunctionExpression(decl.init) || t.isClassExpression(decl.init)
      );
    return false;
  };

  // (getBinding, not hasBinding: hasBinding counts the built-in globals, eval and Math among them, as bound.)
  const isGlobal = (node: t.Node, path: NodePath, names: Set<string> | string) =>
    t.isIdentifier(node) &&
    (typeof names === "string" ? node.name === names : names.has(node.name)) &&
    !path.scope.getBinding(node.name);

  /** A call or `new`: what it's called on and its object arguments noted; bracketed. False when there's nothing to note. */
  const markCall = (path: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>): boolean => {
    const node = path.node;
    const callee = node.callee;
    if (ownCallee(callee, path)) return false;
    let noted = false;
    const thisToo = { needed: false };
    if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
      // console.log(...) only reads; Math.max(...) never changes Math.
      if (isGlobal(callee.object, path, "console")) return false;
      if (!isGlobal(callee.object, path, NAMESPACES)) {
        writing(callee, thisToo);
        noted = true;
      }
    } else if (!t.isSuper(callee) && !isGlobal(callee, path, PLAIN_GLOBALS) && t.isExpression(callee)) {
      // A function called through a name or a value (not the program's own): noted itself, since a
      // bound one (a.push.bind(a)) changes what it was bound to (runtime.ts w).
      (node as { callee: t.Expression }).callee = call("w", [callee]);
      noted = true;
    }
    node.arguments = node.arguments.map((arg) => {
      if (t.isSpreadElement(arg)) {
        if (primitive(arg.argument)) return arg;
        noted = true;
        return t.spreadElement(call("w", [arg.argument]));
      }
      if (!t.isExpression(arg) || primitive(arg) || fresh(arg)) return arg;
      noted = true;
      return call("w", [arg]);
    });
    if (!noted && !thisToo.needed) return false;
    const root = chainRoot(path);
    if (root !== path || path.isOptionalCallExpression()) {
      // Part of an optional chain: noted in place, the chain bracketed whole once it's done.
      chains.set(root.node, (chains.get(root.node) ?? false) || thisToo.needed);
      return true;
    }
    path.replaceWith(bracket(node, thisToo.needed));
    path.skip();
    return true;
  };

  /** A chain's outermost node, done: bracketed if a call in it noted something. */
  const finishChain = (path: NodePath) => {
    if (!chains.has(path.node)) return;
    const thisToo = chains.get(path.node)!;
    chains.delete(path.node);
    path.replaceWith(bracket(path.node as t.Expression, thisToo));
    path.skip();
  };

  traverse(ast, {
    // Code marks can't follow: the run reads every object instead.
    WithStatement() {
      noteUnsafe("with");
    },
    Identifier(path) {
      const name = path.node.name;
      if ((name === "eval" || name === "Function") && path.isReferencedIdentifier() && !path.scope.getBinding(name))
        noteUnsafe(name);
    },
    MemberExpression(path) {
      const prop = path.node.property;
      if (!path.node.computed && t.isIdentifier(prop) && (prop.name === "eval" || prop.name === "Function"))
        noteUnsafe(prop.name);
    },
    "ForInStatement|ForOfStatement"(path) {
      const left = (path.node as t.ForInStatement | t.ForOfStatement).left;
      if (!t.isVariableDeclaration(left) && memberTargets(left).length) noteUnsafe("a field as a loop's target");
    },

    // Writes.
    AssignmentExpression: {
      exit(path) {
        if (made.has(path.node)) return;
        const targets = memberTargets(path.node.left);
        if (!targets.length) return;
        const thisToo = { needed: false };
        for (const member of targets) writing(member, thisToo);
        path.replaceWith(bracket(path.node, thisToo.needed));
        path.skip();
      },
    },
    UpdateExpression: {
      exit(path) {
        const arg = path.node.argument;
        if (!t.isMemberExpression(arg)) return;
        const thisToo = { needed: false };
        writing(arg, thisToo);
        path.replaceWith(bracket(path.node, thisToo.needed));
        path.skip();
      },
    },
    UnaryExpression: {
      exit(path) {
        const arg = path.node.argument;
        if (path.node.operator !== "delete" || !(t.isMemberExpression(arg) || t.isOptionalMemberExpression(arg)))
          return;
        const thisToo = { needed: false };
        writing(arg, thisToo);
        path.replaceWith(bracket(path.node, thisToo.needed));
        path.skip();
      },
    },

    // Calls.
    "CallExpression|OptionalCallExpression|NewExpression": {
      exit(path) {
        const node = path.node as t.CallExpression;
        if (made.has(node) || isRuntimeCall(node)) return;
        if (markCall(path as NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>) && !path.removed)
          if (path.node === node) finishChain(path);
      },
    },
    OptionalMemberExpression: {
      exit(path) {
        finishChain(path);
      },
    },
    TaggedTemplateExpression: {
      exit(path) {
        if (made.has(path.node)) return;
        const quasi = path.node.quasi;
        let noted = false;
        quasi.expressions = quasi.expressions.map((e) => {
          if (!t.isExpression(e) || primitive(e)) return e;
          noted = true;
          return call("w", [e]);
        });
        const thisToo = { needed: false };
        const tag = path.node.tag;
        if ((t.isMemberExpression(tag) || t.isOptionalMemberExpression(tag)) && !ownCallee(tag, path)) {
          writing(tag, thisToo);
          noted = true;
        }
        if (!noted) return;
        path.replaceWith(bracket(path.node, thisToo.needed));
        path.skip();
      },
    },
  });
  return unsafe;
}
