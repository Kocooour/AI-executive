// UI-neutral coordinator for owner-selected recovery inspections.
// A new selection (including cancel) atomically resets the busy/result state.
// Superseded asynchronous reads never publish stale content, errors or "busy".
export type RecoveryInspectionState<T> = {
  busy: boolean;
  result: T | null;
  error: "invalid" | "server" | null;
};

export async function runLatestRecoveryInspection<FileSource, Result>(
  sequence: { current: number },
  file: FileSource | null,
  inspect: (source: FileSource) => Promise<Result>,
  publish: (state: RecoveryInspectionState<Result>) => void,
): Promise<void> {
  const requestId = ++sequence.current;
  publish({ busy: file !== null, result: null, error: null });
  if (file === null) return;

  try {
    const result = await inspect(file);
    if (sequence.current === requestId) publish({ busy: false, result, error: null });
  } catch (error) {
    if (sequence.current === requestId) {
      publish({
        busy: false, result: null,
        error: error instanceof Error && error.message === "OFFLINE_REVIEW_SERVER" ? "server" : "invalid",
      });
    }
  }
}
