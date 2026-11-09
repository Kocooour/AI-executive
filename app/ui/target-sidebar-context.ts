"use client";
import { createContext } from "react";

/** R3-FE-4a: what the sidebar shows of the target project index (set by the app root). */
export type TargetSidebarProps = { projects: boolean; openable: boolean };
export const TargetSidebarContext = createContext<TargetSidebarProps | undefined>(undefined);
