/** Runs and traces JavaScript in a Web Worker, so user code can't freeze the page. */
import { serve } from "./serve";
import { traceJavaScript } from "./trace";

serve("JavaScript", traceJavaScript);
