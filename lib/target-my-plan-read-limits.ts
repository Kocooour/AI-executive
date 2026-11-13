/** R3-A3: a single bounded response budget shared by the My Plan child runner
 * and the browser transport. The slice now carries three independently paged
 * buckets (Today, Tomorrow, Undated), up to 100 task titles per bucket.
 * Valid title edits can contain 4096 escapable UTF-16 code units; escaped JSON
 * and the three internal Area witnesses can exceed the old 1 MiB child cap.
 * Keep other staging children at their unchanged 1 MiB default. */
export const MAX_MY_PLAN_SLICE_OUTPUT_BYTES=16*1024*1024;
