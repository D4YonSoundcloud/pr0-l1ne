/**
 * Checks a trace against the trace schema (schema/trace.schema.json,
 * generated from types.ts by `npm run schema`).
 *
 * Used by the tests (every golden trace and every conformance trace), with
 * every problem explained. The app checks what the runner sends with
 * checkTrace.ts instead: the same schema, compiled when building (Ajv's
 * compile here needs eval), and quicker on traces that share heap objects.
 */
import Ajv, { type ErrorObject } from "ajv";
import schema from "../../schema/trace.schema.json";
import { describe } from "./schemaErrors";

export { fieldPath } from "./schemaErrors";

let check: ReturnType<Ajv["compile"]> | null = null;

/**
 * What's wrong with a trace, as readable lines naming the field
 * ("steps[3].heap.o4.items[0]: needs a \"kind\""), or [] when it's valid.
 * At most `limit` problems are listed.
 */
export function traceProblems(trace: unknown, limit = 5): string[] {
  check ??= new Ajv({ allErrors: true, verbose: true, strict: false }).compile(schema);
  if (check(trace)) return [];
  return relevant(check.errors ?? [])
    .slice(0, limit)
    .map(describe);
}

/**
 * A heap object or value is one of several kinds (a union, `anyOf` in the
 * schema). When it fails, the validator explains why it isn't each kind;
 * only the kind its own `kind` field names is worth reading. Drop the
 * branches whose `kind` didn't match, and the summary "doesn't match any".
 */
function relevant(errors: ErrorObject[]): ErrorObject[] {
  // The kinds a branch of the union allows: `kind: "dict"` or `kind: "list" | "tuple" | "set"`.
  const kindsOf = (schema: unknown): unknown[] | undefined => {
    const kind = (schema as { properties?: { kind?: { const?: unknown; enum?: unknown[] } } } | undefined)?.properties
      ?.kind;
    if (!kind) return undefined;
    return kind.enum ?? (kind.const !== undefined ? [kind.const] : undefined);
  };
  const otherKind = (e: ErrorObject) => {
    // An error about the object itself, from a kind it isn't.
    const kinds = kindsOf(e.parentSchema);
    if (kinds) return !kinds.includes((e.data as { kind?: unknown } | null)?.kind);
    // The "kind should be X" error from a kind it isn't.
    return (e.keyword === "const" || e.keyword === "enum") && e.instancePath.endsWith("/kind");
  };
  const kept = errors.filter((e) => e.keyword !== "anyOf" && !otherKind(e));
  if (kept.length) return kept;
  // Every kind was rejected: its `kind` itself is wrong.
  const anyOf = errors.find((e) => e.keyword === "anyOf");
  return anyOf ? [{ ...anyOf, message: 'isn\'t any kind the trace format knows (check its "kind")' }] : errors;
}
