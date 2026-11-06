"use client";

import { useEffect, useRef } from "react";
import { desktopCaptureShortcut } from "../../../lib/desktop-shell-ui03a";
import { mobileDesignV1Preview } from "../navigation";
import type { LumiApp } from "../use-lumi-app";

/** Desktop-only action in the existing, default-off Lumi v1 preview.
 * Keyboard and click both use openCapture's existing scope/consent rules.
 */
export function DesktopCaptureFab({ app }: { app: LumiApp }) {
  const currentApp = useRef(app);
  currentApp.current = app;

  useEffect(() => {
    if (!mobileDesignV1Preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!window.matchMedia("(min-width: 701px)").matches) return;
      const state = currentApp.current;
      const target = event.target instanceof Element ? event.target : null;
      const editable = Boolean(target?.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      ) || (target as HTMLElement | null)?.isContentEditable);
      // A selected item is displayed in a NONMODAL desktop inspector; its
      // sidebar remains accessible. Allow capture via shortcut, while real
      // modal/dialog overlays continue to block global keyboard commands.
      const blocked = Boolean(state.capture || state.assistantOpen || state.moreOpen ||
        state.confirmRequest || document.querySelector('[aria-modal="true"]'));
      if (!desktopCaptureShortcut(event, editable, blocked)) return;
      event.preventDefault();
      state.openCapture();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!mobileDesignV1Preview) return null;
  const blocked = Boolean(app.capture || app.assistantOpen || app.moreOpen ||
    app.selected || app.confirmRequest);
  return (
    <button type="button" className="desktopCaptureFab"
      data-desktop-capture-fab disabled={blocked}
      aria-label={app.tr("quickCapture")}
      title={`${app.tr("quickCapture")} · ⌘⇧.`}
      onClick={() => app.openCapture()}>
      <span aria-hidden="true">＋</span>
    </button>
  );
}
