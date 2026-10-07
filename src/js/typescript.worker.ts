/** Runs and traces TypeScript in a Web Worker, so user code can't freeze the page. */
import { serve } from "./serve";
import { traceTypeScript } from "./typescript";

serve("TypeScript", traceTypeScript);
