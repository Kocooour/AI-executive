// The time a local write records as `updatedAt`. Two writes in the same millisecond must not get
// the same value: the checks that tell whether the local copy holds unsent changes
// (lib/tab-coordination.ts, lib/field-merge.ts) compare records by it. Within a tab the value is
// therefore strictly increasing (a whole number of milliseconds, as the server expects).
let last = 0;
export function writeTime() {
  const now = Date.now();
  last = now > last ? now : last + 1;
  return last;
}
