/**
 * Owner archive streams must stop when the globally persisted logout cutoff
 * advances during a download, not just when the route first admits the GET.
 * A zero-prefetch Web stream and per-chunk checks prevent queued private
 * chunks from being handed to the response after observed revocation.
 */
import { Readable } from "node:stream";
import { isAuthenticated } from "./auth";

export function ownerSessionCheckedStream(request: Request, source: Readable): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let closed = false;
  const stop = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    closed = true;
    source.destroy();
    controller.error(new Error("Owner session revoked during export"));
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      if (!isAuthenticated(request)) return stop(controller);
      try {
        const chunk = await iterator.next();
        if (!isAuthenticated(request)) return stop(controller);
        if (chunk.done) {
          closed = true;
          controller.close();
        } else {
          controller.enqueue(chunk.value as Uint8Array);
        }
      } catch (error) {
        closed = true;
        source.destroy();
        controller.error(error);
      }
    },
    cancel() {
      closed = true;
      source.destroy();
    },
  }, { highWaterMark: 0 });
}
