// Keep a person's explicit estimate in whole minutes, including short tasks.
export function taskMinutes(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const minutes = Number(value);
  return Number.isFinite(minutes) && Number.isInteger(minutes) && minutes >= 1 && minutes <= 480
    ? minutes
    : null;
}

export function clampTaskMinutes(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.max(1, Math.min(480, Math.round(minutes))) : null;
}
