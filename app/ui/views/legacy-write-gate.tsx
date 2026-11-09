"use client";
import { useContext, type ReactNode } from "react";
import { LegacyWritesContext } from "../legacy-writes-context";

/** Wraps a legacy write-only control group: in unified target mode every control inside is
 * natively disabled (fieldset) with the notice as tooltip; otherwise it renders its children as is. */
export function LegacyWriteGate({ children }: { children: ReactNode }) {
  const writes = useContext(LegacyWritesContext);
  if (!writes.disabled) return <>{children}</>;
  return <fieldset disabled className="legacyWriteGate" title={writes.hint} aria-disabled="true">{children}</fieldset>;
}
