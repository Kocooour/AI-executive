"use client";
import { handleOverlayKeys } from "../focus";
import { mobileViews, moreViews } from "../navigation";
import type { LumiApp } from "../use-lumi-app";
import { ViewIcon } from "./project-icon";

export function MobileNav({ app }: { app: LumiApp }) {
  const {
    closeDetail,
    language,
    moreDialogRef,
    moreOpen,
    moreTriggerRef,
    openCapture,
    setMoreOpen,
    setView,
    tr,
    view,
  } = app;
  return (
    <>
      <nav className="mobileNav">
        {mobileViews.map((x) => (
          <button
            key={x}
            ref={x === "More" ? moreTriggerRef : undefined}
            className={view === x || (x === "More" && (moreOpen || moreViews.includes(view))) ? "active" : ""}
            aria-label={tr(x)}
            aria-current={view === x || (x === "More" && moreViews.includes(view)) ? "page" : undefined}
            aria-expanded={x === "More" ? moreOpen : undefined}
            aria-controls={x === "More" ? "mobile-more-dialog" : undefined}
            aria-haspopup={x === "More" ? "dialog" : undefined}
            onClick={() => {
              if (x === "More") return setMoreOpen((open) => !open);
              setMoreOpen(false);
              closeDetail();
              setView(x);
            }}
          >
            <span className="mobileNavIcon" aria-hidden="true"><ViewIcon name={x} /></span><span>{tr(x)}</span>
          </button>
        ))}
      </nav>
      <button className="mobileCaptureButton" type="button" onClick={() => openCapture()} aria-label={tr("quickCapture")} title={tr("quickCapture")}>＋</button>
      {moreOpen && (
        <div className="mobileMoreBackdrop" onClick={() => setMoreOpen(false)}>
          <div id="mobile-more-dialog" className="mobileMore" role="dialog" aria-modal="true" aria-label={tr("More")} ref={moreDialogRef} onClick={(e) => e.stopPropagation()} onKeyDown={(event) => handleOverlayKeys(event, () => setMoreOpen(false))}>
            <button type="button" className="mobileMoreClose" onClick={() => setMoreOpen(false)}>{tr("closeMenu")}</button>
            {moreViews.map((item) => (
              <button
                key={item}
                className={view === item ? "active" : ""}
                onClick={() => {
                  setView(item);
                  closeDetail();
                  setMoreOpen(false);
                }}
              >
                {tr(item)}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
