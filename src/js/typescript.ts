/**
 * TypeScript support: strip the types, then trace the result as JavaScript.
 *
 * Types don't exist at runtime, so tracing TypeScript is tracing the
 * JavaScript it compiles to. Babel's official TypeScript transform does the
 * stripping. Most TypeScript (annotations, interfaces, type aliases, generics,
 * `as`, `!`, `satisfies`, overload signatures, `abstract` and `declare`
 * members) simply disappears, and everything you wrote keeps its original
 * line numbers.
 *
 * A few constructs compile to new code: enums and namespaces become helper
 * functions, and constructor parameter properties (`constructor(public x)`)
 * become `this.x = x`. That generated code has no source location, which the
 * instrumenter takes as "run this, but don't trace it". The one thing we add
 * back is the line of each enum and namespace declaration, so declaring one
 * still shows up as a step.
 *
 * This module is only imported by the TypeScript worker, so the JavaScript
 * worker never downloads Babel's core.
 */
import { transformFromAstSync } from "@babel/core";
import transformTypeScript from "@babel/plugin-transform-typescript";
import * as t from "@babel/types";
import type { Trace } from "../trace/types";
import { InstrumentError, instrumentAst, parseProgram, type Instrumented } from "./instrument";
import { traceProgram } from "./trace";

export function stripTypes(ast: t.File, source: string): t.File {
  // Remember where each enum and namespace was declared, by name.
  const declared = new Map<string, t.SourceLocation[]>();
  t.traverseFast(ast, (node) => {
    if ((t.isTSEnumDeclaration(node) || t.isTSModuleDeclaration(node)) && t.isIdentifier(node.id) && node.loc) {
      declared.set(node.id.name, [...(declared.get(node.id.name) ?? []), node.loc]);
    }
  });

  let result;
  try {
    result = transformFromAstSync(ast, source, {
      ast: true,
      code: false,
      babelrc: false,
      configFile: false,
      browserslistConfigFile: false,
      // Set explicitly so Babel never consults process.cwd() or
      // process.env, which don't exist in a browser.
      cwd: "/",
      envName: "production",
      sourceType: "script",
      cloneInputAst: false,
      plugins: [transformTypeScript],
    });
  } catch (error) {
    // The transform rejects a few things the parser accepts, such as
    // `declare` on a field that also has an initializer.
    const err = error as { message: string; loc?: { line: number } };
    throw new InstrumentError(err.message.replace(/^.*?: /, "").split("\n")[0], err.loc?.line ?? null);
  }
  if (!result?.ast) throw new InstrumentError("TypeScript could not be converted to JavaScript.", null);

  // The enum or namespace now starts with a generated `var Name = ...` or
  // `let Name;`. Give it the original declaration's line.
  t.traverseFast(result.ast, (node) => {
    if (!t.isVariableDeclaration(node) || node.loc || node.declarations.length !== 1) return;
    const id = node.declarations[0].id;
    const loc = t.isIdentifier(id) ? declared.get(id.name)?.shift() : undefined;
    if (loc) node.loc = loc;
  });
  // Keep the comments, so `// viz:` hints still work.
  if (!result.ast.comments?.length) result.ast.comments = ast.comments;
  return result.ast;
}

export function instrumentTypeScript(source: string): Instrumented {
  return instrumentAst(stripTypes(parseProgram(source, ["typescript"]), source), source);
}

export function traceTypeScript(source: string, maxSteps = 2000): Promise<Trace> {
  return traceProgram(source, maxSteps, "typescript", instrumentTypeScript);
}
