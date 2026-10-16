/**
 * Checks a trace against the trace schema (schema/trace.schema.json,
 * generated from types.ts by `npm run schema`).
 *
 * Used by the tests (every golden trace and every conformance trace) and,
 * in development builds only, by worker/runner.ts on every trace a worker
 * sends. Production builds never load this module or the schema.
 */
import Ajv, { type ErrorObject } from "ajv";
import schema from "../../schema/trace.schema.json";

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

/** A JSON pointer as JavaScript-ish access: /steps/3/heap/o4 -> steps[3].heap.o4 */
export function fieldPath(pointer: string): string {
  const parts = pointer.split("/").slice(1);
  if (!parts.length) return "the trace";
  return parts
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((part, i) => (/^\d+$/.test(part) ? `[${part}]` : i === 0 ? part : `.${part}`))
    .join("");
}

function describe(error: ErrorObject): string {
  const where = fieldPath(error.instancePath);
  const p = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
      return `${where}: needs "${String(p.missingProperty)}"`;
    case "additionalProperties":
      return `${where}: has "${String(p.additionalProperty)}", which isn't part of the trace format`;
    case "const":
      return `${where}: should be ${JSON.stringify(p.allowedValue)}`;
    case "enum":
      return `${where}: should be one of ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    case "type":
      return `${where}: should be ${String(p.type)}`;
    default:
      return `${where}: ${error.message ?? "doesn't match the trace format"}`;
  }
}
