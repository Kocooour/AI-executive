"use client";
import {useContext,type ButtonHTMLAttributes} from "react";
import {LegacyWritesContext} from "../legacy-writes-context";
import type {LumiCompletionTone} from "../../../lib/lumi-completion-state";

type Props=Omit<ButtonHTMLAttributes<HTMLButtonElement>,"children"|"type"|"aria-label"|"aria-pressed"> & {
  kind:"task"|"project";
  tone:LumiCompletionTone;
  complete:boolean;
  actionLabel:string;
  stateLabel:string;
  blockedReason?:string;
  shapeClassName?:string;
};

/** Shared status control for v1 tasks/projects; visual state never grants a write. */
export function LumiCompletionControl({
  kind,tone,complete,actionLabel,stateLabel,blockedReason,shapeClassName,
  className,disabled:ownDisabled,...buttonProps
}:Props){
  // Unified target mode: legacy completion is inert and says so (never a silent no-op).
  const writes=useContext(LegacyWritesContext);
  const disabled=ownDisabled||writes.disabled;
  const label=disabled
    ? `${stateLabel}. ${writes.disabled&&writes.hint?writes.hint:blockedReason||actionLabel}`
    : `${actionLabel}. ${stateLabel}`;
  return (
    <button {...buttonProps} type="button" disabled={disabled}
      className={`lumiCompletionControl${className?` ${className}`:""}`}
      data-completion-kind={kind} data-completion-tone={complete?"complete":tone}
      aria-pressed={complete} aria-label={label} title={label}>
      <span className={`lumiCompletionShape${shapeClassName?` ${shapeClassName}`:""}`} aria-hidden="true">
        {complete?"✓":null}
      </span>
    </button>
  );
}
