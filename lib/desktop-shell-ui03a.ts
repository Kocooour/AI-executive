/** UI-03a: opt-in desktop Quick Capture shortcut, never an authorization gate.
 * The actual action still opens Lumi's existing private-first CaptureDialog.
 * Use the physical Period key on non-US layouts, not Shift's locale-specific
 * character. Do not override text editing, open overlays or browser commands.
 */
export function desktopCaptureShortcut(
  event: {
    code?: string; key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean;
    altKey: boolean; repeat: boolean; defaultPrevented: boolean; isComposing?: boolean;
  },
  editableTarget: boolean,
  overlayOpen: boolean,
): boolean {
  return !event.defaultPrevented && !event.repeat && !event.isComposing &&
    !editableTarget && !overlayOpen &&
    (event.metaKey !== event.ctrlKey) && event.shiftKey && !event.altKey &&
    (event.code === "Period" || event.key === "." || event.key === ">");
}
