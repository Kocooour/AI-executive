"use client";
import { useEffect, useState } from "react";
import { taskMinutes } from "../../../lib/task-duration";

export function DurationInput({ value, onChange, disabled }: {
  value: number | string | undefined;
  onChange: (minutes: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value ?? ""));
  useEffect(() => setDraft(String(value ?? "")), [value]);
  return <input
    type="number" min="1" max="480" step="1" inputMode="numeric"
    value={draft} disabled={disabled}
    onChange={(event) => {
      const raw = event.target.value;
      setDraft(raw);
      const minutes = taskMinutes(raw);
      if (minutes !== null) onChange(minutes);
    }}
    onBlur={() => setDraft(String(value ?? ""))}
  />;
}
