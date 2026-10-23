"use client";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

// A small anchored popover for a row or a header: a trigger button and a panel under it (a bottom
// sheet on a narrow screen, see lumi-today.css). Esc closes it and focus returns to the trigger; a
// press outside closes it. With role "menu" the panel holds `menuitem` buttons moved with the arrow
// keys; with role "group" it holds ordinary controls (the Today filters).
export function PopoverMenu({ label, triggerLabel, triggerClassName, triggerContent, triggerData, role = "menu", className, children }: {
  // Accessible name of the panel and of the trigger button.
  label: string;
  triggerLabel?: string;
  triggerClassName?: string;
  triggerContent: ReactNode;
  triggerData?: Record<string, string>;
  role?: "menu" | "group";
  className?: string;
  children: (close: (returnFocus?: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Opens below the trigger, or above it when there is no room below.
  useLayoutEffect(() => {
    if (!open) { setAbove(false); return; }
    const panel = panelRef.current, root = rootRef.current;
    if (!panel || !root) return;
    const place = () => {
      const rect = root.getBoundingClientRect();
      const height = panel.offsetHeight;
      setAbove(rect.bottom + 6 + height > window.innerHeight - 8 && rect.top - 6 - height >= 8);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(role === "menu" ? '[role="menuitem"]:not([disabled])' : "select, button, input")?.focus();
    const inConfirm = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("dialog.confirmDialog"));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || inConfirm(event.target)) return;
      event.preventDefault();
      close(true);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target) || inConfirm(target)) return;
      close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer); };
  }, [open]);

  const onPanelKey = (event: ReactKeyboardEvent) => {
    if (role === "menu") {
      if (event.key === "Tab") { close(true); return; }
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(event.key) || !panelRef.current) return;
      const entries = [...panelRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
      if (entries.length === 0) return;
      event.preventDefault();
      const index = entries.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
        : event.key === "ArrowDown" ? (index + 1) % entries.length : (index - 1 + entries.length) % entries.length;
      entries[next].focus();
    }
  };

  return (
    <div ref={rootRef} className={`popoverMenu ${className || ""}`.trim()} onClick={(event) => event.stopPropagation()}
      onBlur={role === "group" ? (event) => { if (open && event.relatedTarget instanceof Node && !rootRef.current?.contains(event.relatedTarget)) setOpen(false); } : undefined}>
      <button ref={triggerRef} type="button" className={triggerClassName} aria-label={triggerLabel} aria-haspopup={role === "menu" ? "menu" : "true"}
        aria-expanded={open} aria-controls={open ? id : undefined} {...triggerData}
        onClick={() => setOpen((current) => !current)}>{triggerContent}</button>
      {open && (
        <div ref={panelRef} id={id} role={role} aria-label={label} className={`popoverMenuPanel ${above ? "isAbove" : ""}`.trim()} onKeyDown={onPanelKey}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
