/**
 * Generates schema/trace.schema.json, the JSON Schema for a trace, from the
 * TypeScript types in src/trace/types.ts. Run after changing those types:
 *
 *   npm run schema
 *
 * src/trace/schema.test.ts fails if the committed schema is out of date, so
 * a type change can't land without the schema (and the pull request shows
 * exactly how the contract changed).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const root = new URL("..", import.meta.url);
export const SCHEMA_FILE = fileURLToPath(new URL("schema/trace.schema.json", root));

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
}
