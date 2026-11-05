"use client";
import type {ButtonHTMLAttributes} from "react";
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
  className,disabled,...buttonProps
}:Props){
  const label=disabled
    ? `${stateLabel}. ${blockedReason||actionLabel}`
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
