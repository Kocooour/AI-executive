/**
 * A failed save must not poison subsequent offline-first saves, but an explicit
 * caller (e.g. a confirmed project action) must observe its own failure.
 * Attach the queue catch in the same turn as the operation to avoid unhandled rejections.
 */
export function settleSyncOperation(
  operation: Promise<void>,
  onFailure: (error: unknown) => void,
  reportFailure = false,
): { queue: Promise<void>; result: Promise<void> } {
  const queue = operation.catch(onFailure);
  return { queue, result: reportFailure ? operation : queue };
}
