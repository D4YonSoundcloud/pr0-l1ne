/**
 * The instrumenter's third pass (see instrument.ts): insert the runtime's
 * calls. Done as a plain post-order walk that mutates nodes directly, so
 * nothing is visited twice.
 */
import * as t from "@babel/types";
import type { Analysis, LoopData } from "./analyze";

/** The name the runtime is passed in as. Variables with this prefix are hidden. */
export const RUNTIME = "__av";
const FRAME = "__av_f";
const ERROR = "__av_e";

/** Simple enough to evaluate one extra time: names, numbers, a.length, arithmetic. */
function pureExpression(n: t.Node): boolean {
  if (t.isIdentifier(n) || t.isNumericLiteral(n)) return true;
  if (t.isMemberExpression(n) && !n.computed) return pureExpression(n.object);
  if (t.isBinaryExpression(n) && /^[-+*/%]$/.test(n.operator))
    return pureExpression(n.left as t.Node) && pureExpression(n.right);
  if (t.isUnaryExpression(n) && n.operator === "-") return pureExpression(n.argument);
  return false;
}

/** for (let i = A; i < B; i++) -> B - A (or B - A + 1 for <=), when A and B are simple. */
function countedLoopTotal(node: t.ForStatement): t.Expression | null {
  if (!t.isVariableDeclaration(node.init) || node.init.declarations.length !== 1) return null;
  const decl = node.init.declarations[0];
  if (!t.isIdentifier(decl.id) || !decl.init || !pureExpression(decl.init)) return null;
  const id = decl.id.name;
  const test = node.test;
  const update = node.update;
  const steps =
    (t.isUpdateExpression(update) && update.operator === "++" && t.isIdentifier(update.argument, { name: id })) ||
    (t.isAssignmentExpression(update) &&
      update.operator === "+=" &&
      t.isIdentifier(update.left, { name: id }) &&
      t.isNumericLiteral(update.right, { value: 1 }));
  if (
    !steps ||
    !t.isBinaryExpression(test) ||
    (test.operator !== "<" && test.operator !== "<=") ||
    !t.isIdentifier(test.left, { name: id }) ||
    !pureExpression(test.right)
  )
    return null;
  const count = t.binaryExpression("-", t.cloneNode(test.right as t.Expression), t.cloneNode(decl.init));
  return test.operator === "<=" ? t.binaryExpression("+", count, t.numericLiteral(1)) : count;
}

/**
 * for (let j = A; j OP B; UPDATE): the parts shown as the loop's header on
 * its rows ("j = 0; j < 4; j++"), with A and B evaluated as it starts.
 * Null unless A and B can be evaluated a second time safely.
 */
function countedLoopCall(node: t.ForStatement): t.Expression[] | null {
  if (!t.isVariableDeclaration(node.init) || node.init.declarations.length !== 1) return null;
  const decl = node.init.declarations[0];
  if (!t.isIdentifier(decl.id) || !decl.init || !pureExpression(decl.init)) return null;
  const name = decl.id.name;
  const test = node.test;
  if (
    !t.isBinaryExpression(test) ||
    !["<", "<=", ">", ">=", "!=="].includes(test.operator) ||
    !t.isIdentifier(test.left, { name }) ||
    !pureExpression(test.right)
  )
    return null;
  const update = node.update;
  let updateText: string | null = null;
  if (t.isUpdateExpression(update) && t.isIdentifier(update.argument, { name }))
    updateText = `${name}${update.operator}`;
  else if (
    t.isAssignmentExpression(update) &&
    (update.operator === "+=" || update.operator === "-=" || update.operator === "*=") &&
    t.isIdentifier(update.left, { name }) &&
    t.isNumericLiteral(update.right)
  )
    updateText = `${name} ${update.operator} ${update.right.value}`;
  if (!updateText) return null;
  return [
    t.stringLiteral(name),
    t.stringLiteral(test.operator),
    t.stringLiteral(updateText),
    t.cloneNode(decl.init),
    t.cloneNode(test.right as t.Expression),
  ];
}

const runtimeCall = (method: string, args: t.Expression[]) =>
  t.callExpression(t.memberExpression(t.identifier(RUNTIME), t.identifier(method)), args);

const statement = (method: string, args: t.Expression[]) => t.expressionStatement(runtimeCall(method, args));

/**
 * Calls that belong to a frame pass it first. If the frame isn't on top of
 * the runtime's call stack, it's a generator or async function resuming, and
 * the runtime puts it back (see Runtime.ensure).
 */
const frameCall = (method: string, args: t.Expression[]) => runtimeCall(method, [t.identifier(FRAME), ...args]);
const frameStatement = (method: string, args: t.Expression[]) => t.expressionStatement(frameCall(method, args));

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

export function transform(ast: t.File, a: Analysis): void {
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
        out.push(
          t.blockStatement([
            frameStatement("loopEnter", [t.stringLiteral(id), t.numericLiteral(line), getter(loop.outerVars)]),
            t.tryStatement(
              t.blockStatement([node]),
              null,
              t.blockStatement([frameStatement("loopExit", [t.stringLiteral(id)])]),
            ),
          ]),
        );
        continue;
      }
      const info = a.lines.get(node);
      if (info) out.push(frameStatement("line", [t.numericLiteral(info.line), getter(info.vars)]));
      const cont = a.continues.get(node);
      const contLoop = cont && a.loops.get(cont.loop);
      if (cont && contLoop) {
        // `continue` ends the iteration early, so record the end-of-iteration
        // snapshot here too.
        out.push(
          frameStatement("tail", [
            t.stringLiteral(contLoop.info.id),
            t.numericLiteral(contLoop.info.line),
            getter(cont.vars),
          ]),
        );
      }
      out.push(node);
      const fn = t.isFunctionDeclaration(node) ? a.functions.get(node) : undefined;
      if (fn?.captured.length && t.isFunctionDeclaration(node) && node.id) {
        // Declarations are hoisted, so register them at the top of the block.
        registrations.push(
          statement("fn", [t.identifier(node.id.name), t.stringLiteral(fn.name), getter(fn.captured)]),
        );
      }
    }
    return [...registrations, ...out];
  }

  /** Wrap a function body in enter / try / catch / finally exit. */
  function wrapBody(
    body: t.BlockStatement,
    name: string,
    line: number,
    vars: string[],
    withThis: boolean,
  ): t.BlockStatement {
    const frame = t.identifier(FRAME);
    const error = t.identifier(ERROR);
    return t.blockStatement(
      [
        t.variableDeclaration("const", [
          t.variableDeclarator(
            frame,
            runtimeCall("enter", [t.stringLiteral(name), t.numericLiteral(line), getter(vars, withThis)]),
          ),
        ]),
        t.tryStatement(
          t.blockStatement([...body.body, frameStatement("ret", [VOID(), getter(vars, withThis)])]),
          t.catchClause(error, t.blockStatement([frameStatement("raise", [error]), t.throwStatement(error)])),
          t.blockStatement([statement("exit", [frame])]),
        ),
      ],
      body.directives,
    );
  }

  /**
   * The program's own frame. It isn't popped when the script reaches its end,
   * because async functions and timers may still run: the runtime records
   * "Program finished" once they're all done (Runtime.finish).
   */
  function wrapProgram(body: t.Statement[], vars: string[]): t.Statement[] {
    const frame = t.identifier(FRAME);
    const error = t.identifier(ERROR);
    return [
      t.variableDeclaration("const", [
        t.variableDeclarator(
          frame,
          runtimeCall("enter", [t.stringLiteral("Global"), t.numericLiteral(0), getter(vars)]),
        ),
      ]),
      t.tryStatement(
        t.blockStatement([...body, frameStatement("mainDone", [getter(vars)])]),
        t.catchClause(error, t.blockStatement([frameStatement("raise", [error]), t.throwStatement(error)])),
      ),
    ];
  }

  /** Put a replacement node where `ancestors` says the current node is. */
  function replaceInParent(ancestors: t.TraversalAncestors, replacement: t.Node): void {
    const parent = ancestors[ancestors.length - 1];
    const slot = (parent.node as unknown as Record<string, unknown>)[parent.key];
    if (Array.isArray(slot)) slot[parent.index!] = replacement;
    else (parent.node as unknown as Record<string, unknown>)[parent.key] = replacement;
  }

  // Nodes this pass creates, so they aren't wrapped twice.
  const created = new WeakSet<t.Node>();

  t.traverse(ast, {
    exit(node, ancestors) {
      if (t.isProgram(node)) {
        node.body = wrapProgram(processList(node.body), a.programVars);
        return;
      }

      // Pausing: `yield x` becomes
      //   __av.resumed(f, yield __av.yielding(f, x))
      // so the runtime knows the frame is leaving the stack, and when it's back.
      if (t.isYieldExpression(node) && !created.has(node)) {
        const inner = t.yieldExpression(
          frameCall(node.delegate ? "delegating" : "yielding", [node.argument ?? VOID()]),
          node.delegate,
        );
        created.add(inner);
        replaceInParent(ancestors, frameCall("resumed", [inner]));
        return;
      }
      if (t.isAwaitExpression(node) && !created.has(node)) {
        const inner = t.awaitExpression(frameCall("awaiting", [node.argument]));
        created.add(inner);
        replaceInParent(ancestors, frameCall("resumed", [inner]));
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
        node.body.body.unshift(frameStatement("loopIter", [t.stringLiteral(id)]));
        node.body.body.push(
          frameStatement("tail", [t.stringLiteral(id), t.numericLiteral(line), getter(loop.bodyVars)]),
        );
        // `for await` pauses before every item without an await of its own,
        // so the runtime wraps the iterable to see those pauses.
        if (t.isForOfStatement(node) && node.await) node.right = frameCall("asyncIter", [node.right]);
        // Tell the runtime how many passes the loop will make, when that's
        // known as it starts, so a long loop can be sampled (see runtime.ts).
        else if (t.isForOfStatement(node)) node.right = frameCall("loopLength", [t.stringLiteral(id), node.right]);
        if (t.isForStatement(node)) {
          const total = countedLoopTotal(node);
          const call = countedLoopCall(node); // before either rewrites the start
          if (total && t.isVariableDeclaration(node.init)) {
            const decl = node.init.declarations[0];
            decl.init = t.sequenceExpression([frameCall("loopTotal", [t.stringLiteral(id), total]), decl.init!]);
          }
          if (call && t.isVariableDeclaration(node.init)) {
            const decl = node.init.declarations[0];
            decl.init = t.sequenceExpression([frameCall("loopCall", [t.stringLiteral(id), ...call]), decl.init!]);
          }
        }
        return;
      }

      if (t.isReturnStatement(node) && a.returns.has(node)) {
        node.argument = frameCall("ret", [node.argument ?? VOID()]);
        return;
      }

      const fn = a.functions.get(node);
      if (fn && t.isFunction(node) && t.isBlockStatement(node.body)) {
        node.body = wrapBody(node.body, fn.name, fn.line, fn.vars, fn.withThis);
        // Closures: register captured variables so the heap view can show
        // them. Function declarations are registered in processList instead.
        if (fn.captured.length && (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node))) {
          replaceInParent(ancestors, runtimeCall("fn", [node, t.stringLiteral(fn.name), getter(fn.captured)]));
        }
      }
    },
  });
}
