/// <reference lib="webworker" />
/**
 * Runs SQL in a Web Worker, on the runner's site like every language:
 * starts Postgres (PGlite) and its parser, then answers "run" messages with
 * a Trace (trace.ts). Postgres takes a few seconds to start, once; each run
 * after that takes milliseconds.
 *
 * Measure counts how often each line runs, which means nothing for a SQL
 * statement: the app doesn't offer it for SQL, and a "measure" message
 * gets an error.
 */
import { workerChannel } from "../worker/channel";
import { type FromWorker, PROTOCOL_VERSION, type ToWorker } from "../worker/protocol";
import { PgliteEngine } from "./engine";
import { loadParser, type SqlParser } from "./parser";
import { traceSql } from "./trace";

const channel = workerChannel();
const post = (message: FromWorker) => channel.post(message);

let ready: Promise<{ engine: PgliteEngine; parser: SqlParser }> | null = null;
/** One message at a time: a run is a transaction on the one database. */
let queue: Promise<void> = Promise.resolve();

async function handle(message: ToWorker): Promise<void> {
  if (!ready) return;
  let tools: { engine: PgliteEngine; parser: SqlParser };
  try {
    tools = await ready;
  } catch {
    return; // reported as a loadError
  }
  if (message.type === "measure") {
    post({ type: "crash", runId: message.runId, message: "Measure doesn't run SQL" });
    return;
  }
  const started = performance.now();
  try {
    const trace = await traceSql(message.source, tools.engine, tools.parser);
    post({ type: "result", runId: message.runId, trace, elapsedMs: performance.now() - started });
  } catch (error) {
    post({ type: "crash", runId: message.runId, message: error instanceof Error ? error.message : String(error) });
  }
}

channel.listen((message) => {
  queue = queue.then(() => handle(message));
});

ready = Promise.all([PgliteEngine.create(), loadParser()]).then(([engine, parser]) => ({ engine, parser }));
ready.then(
  async ({ engine }) => post({ type: "ready", label: await engine.version(), protocolVersion: PROTOCOL_VERSION }),
  (error: unknown) => post({ type: "loadError", message: error instanceof Error ? error.message : String(error) }),
);
