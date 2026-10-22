/**
 * Schema errors as readable lines naming the field, for both checks: the
 * tests' (validate.ts) and the app's (checkTrace.ts).
 */

/** What both validators report about an error (Ajv's ErrorObject, in part). */
export interface SchemaError {
  instancePath: string;
  keyword: string;
  params: Record<string, unknown> | object;
  message?: string;
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

/** One schema error as a readable line naming the field. */
export function describe(error: SchemaError): string {
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
