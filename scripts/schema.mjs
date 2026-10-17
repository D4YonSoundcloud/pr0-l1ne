/**
 * Generates the files written from TypeScript sources. Run after changing
 * src/trace/types.ts or src/trace/policy.ts:
 *
 *   npm run schema
 *
 * - schema/trace.schema.json, the JSON Schema for a trace, from the types in
 *   src/trace/types.ts. src/trace/schema.test.ts fails if it's out of date,
 *   so a type change can't land without the schema (and the pull request
 *   shows exactly how the contract changed).
 * - fixtures/policy.json, the tracing policy in src/trace/policy.ts, for
 *   running the Python tracer outside the app. src/trace/policy.test.ts
 *   fails if it's out of date.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";
import { policyText } from "../src/trace/policy.ts";

const root = new URL("..", import.meta.url);
export const SCHEMA_FILE = fileURLToPath(new URL("schema/trace.schema.json", root));
export const POLICY_FILE = fileURLToPath(new URL("fixtures/policy.json", root));

/** The schema as text, exactly as it's written to the file. */
export function generateSchemaText() {
  const generator = createGenerator({
    path: fileURLToPath(new URL("src/trace/types.ts", root)),
    tsconfig: fileURLToPath(new URL("tsconfig.json", root)),
    type: "Trace",
    skipTypeCheck: true, // npm run typecheck does that
    sortProps: true,
  });
  const schema = {
    $id: "https://pr0l1ne.pages.dev/schema/trace.schema.json",
    $comment: "Generated from src/trace/types.ts by `npm run schema`. Don't edit by hand.",
    title: "PR0L1NE trace",
    ...generator.createSchema("Trace"),
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SCHEMA_FILE, generateSchemaText());
  console.log(`Wrote ${SCHEMA_FILE}`);
  writeFileSync(POLICY_FILE, policyText());
  console.log(`Wrote ${POLICY_FILE}`);
}
