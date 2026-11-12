"use client";

import { useEffect, useRef } from "react";
import { desktopCaptureShortcut } from "../../../lib/desktop-shell-ui03a";
import { mobileDesignV1Preview } from "../navigation";
import type { LumiApp } from "../use-lumi-app";

/** One desktop FAB, with an independently gated private-note target action. */
export function DesktopCaptureFab({ app, onTargetCapture, targetCaptureOpen = false, targetIncludesTasks = false }: {
  app: LumiApp; onTargetCapture?:()=>void; targetCaptureOpen?:boolean; targetIncludesTasks?:boolean;
}) {
  const currentApp = useRef(app);
  currentApp.current = app;
  const targetState=useRef({onOpen:onTargetCapture,open:targetCaptureOpen});
  targetState.current={onOpen:onTargetCapture,open:targetCaptureOpen};

  useEffect(() => {
    if (!mobileDesignV1Preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!window.matchMedia("(min-width: 701px)").matches) return;
      const state = currentApp.current;
      if (state.captureDisabled && !targetState.current.onOpen) return;
      const target = event.target instanceof Element ? event.target : null;
      const editable = Boolean(target?.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      ) || (target as HTMLElement | null)?.isContentEditable);
      // A selected item is displayed in a NONMODAL desktop inspector; its
      // sidebar remains accessible. Allow capture via shortcut, while real
      // modal/dialog overlays continue to block global keyboard commands.
      const blocked = Boolean(state.capture || state.assistantOpen || state.moreOpen ||
        state.confirmRequest || state.offlineView || targetState.current.open ||
        document.querySelector('[aria-modal="true"]'));
      if (!desktopCaptureShortcut(event, editable, blocked)) return;
      event.preventDefault();
      if(targetState.current.onOpen)targetState.current.onOpen();
      else state.openCapture();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!mobileDesignV1Preview) return null;
  if (app.captureDisabled && !onTargetCapture) return null;
  const blocked = Boolean(app.capture || app.assistantOpen || app.moreOpen ||
    app.selected || app.confirmRequest || app.offlineView || targetCaptureOpen);
  const label=onTargetCapture
    ?(targetIncludesTasks?(app.language==="cs"?"Rychlé přidání":"Quick capture"):(app.language==="cs"?"Nová soukromá poznámka":"New private note"))
    :app.tr("quickCapture");
  return (
    <button type="button" className="desktopCaptureFab"
      data-desktop-capture-fab data-target-private-capture-fab={onTargetCapture?"desktop":undefined}
      disabled={blocked}
      aria-label={label}
      title={`${label} · ⌘⇧.`}
      onClick={onTargetCapture ?? (()=>app.openCapture())}>
      <span aria-hidden="true">＋</span>
    </button>
  );
}
