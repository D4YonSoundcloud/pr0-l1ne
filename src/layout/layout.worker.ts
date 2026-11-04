/// <reference lib="webworker" />
/**
 * The layout worker: the trace, prepared, and every window's scene and
 * layout, off the page's thread (layout/host.ts answers its messages,
 * layout/session.ts does the work). The page sends it the run's pieces as
 * they arrive and asks for a window's step; it answers with the drawing,
 * as a patch on the last one it sent that window (render/wire.ts), so a
 * step costs the page only what changed.
 */

import { layoutHost } from "./host";
import type { FromLayout, ToLayout } from "./protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const handle = layoutHost((message: FromLayout) => scope.postMessage(message));
scope.onmessage = (event: MessageEvent<ToLayout>) => handle(event.data);
