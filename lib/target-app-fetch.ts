/** R3: the ONE fetch the main app uses for target reads that spawn a staging read child.
 * The server runs at most two read children at once (lib/target-staging-read-process.ts
 * MAX_CONCURRENT) and answers 503 beyond that, so every such read shares the single client
 * queue of lib/target-read-queue.ts; writes (PATCH/POST/DELETE) bypass it exactly as in
 * lib/target-edit-fetch.ts, so a stalled write never starves a list. The runtime session check
 * (GET /session) is NOT routed here: it is answered in-process (no child) and gates every read.
 * The browser global is resolved lazily so tests may replace it. */
import {queuedTargetFetch} from "./target-read-queue";
import {routeTargetFetch} from "./target-edit-fetch";

const browserFetch:typeof fetch=((input,init)=>fetch(input,init)) as typeof fetch;
export const targetAppFetch:typeof fetch=routeTargetFetch(queuedTargetFetch(browserFetch),browserFetch);
