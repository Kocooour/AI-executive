"use client";
import { createContext } from "react";

/** R3-FE-4a: unified target mode makes legacy user writes inert. Leaf controls read this
 * (disabled + the calm notice as tooltip) instead of silently doing nothing. */
export type LegacyWrites = { disabled: boolean; hint: string | undefined };
export const LegacyWritesContext = createContext<LegacyWrites>({ disabled: false, hint: undefined });
