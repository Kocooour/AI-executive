import { useLayoutEffect, useRef } from "react";
import { type LumiApp } from "../use-lumi-app";

// The one confirmation dialog of the app. A native modal <dialog> keeps focus inside, makes the
// rest of the page inert and closes on Escape; focus returns to the control that opened it.
export function ConfirmDialog({ app }: { app: LumiApp }) {
  const { answerConfirm, confirmRequest, tr } = app;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const closedByUs = useRef(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !confirmRequest) return;
    const opener = confirmRequest.returnFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) { closedByUs.current = true; dialog.close(); }
      const restore = () => { if (opener?.isConnected) opener.focus(); };
      restore();
      // The opener may still be disabled while its action finishes; try once more shortly after.
      window.setTimeout(() => { if (document.activeElement === document.body) restore(); }, 150);
    };
  }, [confirmRequest]);

  if (!confirmRequest) return null;
  return (
    <dialog
      ref={dialogRef}
      className="confirmDialog"
      role={confirmRequest.danger ? "alertdialog" : undefined}
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      onCancel={(event) => { event.preventDefault(); answerConfirm(false); }}
      onClose={() => {
        // Closed by the browser without an answer: treat it as "no" so nothing waits forever.
        if (closedByUs.current) closedByUs.current = false;
        else answerConfirm(false);
      }}
      onMouseDown={(event) => { pressedOutside.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        // Only a press that both starts and ends on the backdrop cancels, not a text selection dragged outside.
        if (event.target === event.currentTarget && pressedOutside.current) answerConfirm(false);
        pressedOutside.current = false;
      }}
    >
      <div className="confirmDialogBody">
        <h2 id="confirm-dialog-title">{confirmRequest.title}</h2>
        <p id="confirm-dialog-message">{confirmRequest.message}</p>
        <div className="confirmDialogActions">
          <button type="button" onClick={() => answerConfirm(false)}>{tr("cancel")}</button>
          <button type="button" className={confirmRequest.danger ? "confirmDanger" : "confirmPrimary"} onClick={() => answerConfirm(true)}>
            {confirmRequest.confirmLabel || tr("confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
