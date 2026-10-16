/** Runs and traces TypeScript in a Web Worker, so user code can't freeze the page. */
import { parseProgram } from "./instrument";
import { measureProgram } from "./measure";
import { serve } from "./serve";
import { stripTypes, traceTypeScript } from "./typescript";

serve("TypeScript", traceTypeScript, (source, limitMs, report, overrides) =>
  measureProgram(source, limitMs, (s) => stripTypes(parseProgram(s, ["typescript"]), s), report, overrides),
);
