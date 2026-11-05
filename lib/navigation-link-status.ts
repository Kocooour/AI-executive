// UI-01c: an address is a requested locator, never proof that a record exists
// or that the current actor may read it. This helper contains no record data.
const targetKeys = ["projectId", "taskId", "noteId"] as const;

export function requestsTypedRecord(search: string): boolean {
  const params = new URLSearchParams(search);
  // Even malformed or ambiguous typed URLs deserve an indistinguishable
  // unavailable response after the initial authenticated snapshot is loaded.
  // Legacy push ?task=... is intentionally handled by its separate path.
  return targetKeys.some((key) => params.has(key));
}

export function showUnavailableLink(search: string, resolved: boolean): boolean {
  return requestsTypedRecord(search) && !resolved;
}
