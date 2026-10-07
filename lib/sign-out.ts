// The decision sequence of signing out, kept free of browser APIs so it can be tested.
// Invariant: the local wipe is reached only when no local write is in progress and every change
// either reached the server or the user agreed to discard it.

export type SignOutResult = "signed-out" | "writing" | "offline" | "kept" | "failed";

export interface SignOutSteps {
  // Counter of local writes: odd while a write is in progress, changed after every write.
  version(): number;
  sleep(ms: number): Promise<void>;
  // Resolves when the queued synchronization has finished (successfully or not).
  drainSync(): Promise<void>;
  hasUnsent(): Promise<boolean>;
  sync(): Promise<void>;
  serverReachable(): Promise<boolean>;
  confirmDiscard(): boolean | Promise<boolean>;
  // Stops user input and write-backs from the server; undone by unblock() when sign-out is abandoned.
  block(): void;
  unblock(): void;
  endSession(): Promise<"ok" | "failed" | "offline">;
  wipe(): Promise<void>;
}

export async function runSignOut(steps: SignOutSteps, options: { writeTimeoutMs?: number; stepMs?: number; rounds?: number } = {}): Promise<SignOutResult> {
  const { writeTimeoutMs = 2000, stepMs = 20, rounds = 3 } = options;
  const writing = () => steps.version() % 2 === 1;
  for (let round = 0; round < rounds; round += 1) {
    for (let waited = 0; writing() && waited < writeTimeoutMs; waited += stepMs) await steps.sleep(stepMs);
    if (writing()) return "writing";
    await steps.drainSync();
    if (await steps.hasUnsent()) await steps.sync();
    const checked = steps.version();
    if (checked % 2 === 1) continue;
    if (await steps.hasUnsent()) {
      if (!(await steps.serverReachable())) return "offline";
      if (!(await steps.confirmDiscard())) return "kept";
    }
    // Anything written while the questions above were open has not been checked yet.
    if (steps.version() !== checked) continue;
    steps.block();
    const ended = await steps.endSession();
    if (ended !== "ok") {
      steps.unblock();
      return ended;
    }
    await steps.wipe();
    return "signed-out";
  }
  return "writing";
}
