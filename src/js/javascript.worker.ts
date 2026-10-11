/** Runs and traces JavaScript in a Web Worker, so user code can't freeze the page. */
import { parseProgram } from "./instrument";
import { measureProgram } from "./measure";
import { serve } from "./serve";
import { traceJavaScript } from "./trace";

serve("JavaScript", traceJavaScript, (source, limitMs, report, overrides) => measureProgram(source, limitMs, (s) => parseProgram(s), report, overrides));
