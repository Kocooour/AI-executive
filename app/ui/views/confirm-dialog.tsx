import { useLayoutEffect, useRef } from "react";
import { type LumiApp } from "../use-lumi-app";

// The one confirmation dialog of the app. A native modal <dialog> keeps focus inside, makes the
// rest of the page inert and closes on Escape; focus returns to the control that opened it.
export function ConfirmDialog({ app }: { app: LumiApp }) {
  const { answerConfirm, confirmRequest, tr } = app;
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !confirmRequest) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [confirmRequest]);

  if (!confirmRequest) return null;
  return (
    <dialog
      ref={dialogRef}
      className="confirmDialog"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      onCancel={(event) => { event.preventDefault(); answerConfirm(false); }}
      onClick={(event) => { if (event.target === event.currentTarget) answerConfirm(false); }}
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
