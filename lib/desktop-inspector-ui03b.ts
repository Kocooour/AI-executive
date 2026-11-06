/** UI-03b: only an unhandled, plain Escape from the inspector's own
 * non-editing surface closes that record view. Nested editors, IME and other
 * overlays must own their own Escape behaviour. No global event listener.
 */
export function inspectorPreviewEscapeAllowed(
  event: {
    key: string;
    defaultPrevented: boolean;
    isComposing?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  },
  editing: boolean,
  blockingOverlay: boolean,
): boolean {
  return event.key === "Escape" && !event.defaultPrevented &&
    !event.isComposing && !event.metaKey && !event.ctrlKey &&
    !event.altKey && !event.shiftKey && !editing && !blockingOverlay;
}
