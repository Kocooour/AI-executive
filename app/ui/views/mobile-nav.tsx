"use client";
import { handleOverlayKeys } from "../focus";
import { mobileMoreGroups, mobileViews, moreViews } from "../navigation";
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
    setInboxTab,
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
            className={x === "More" ? (moreOpen || moreViews.includes(view) ? "active" : "") : (!moreOpen && view === x ? "active" : "")}
            aria-label={tr(x)}
            data-nav-view={x}
            aria-current={!moreOpen && (view === x || (x === "More" && moreViews.includes(view))) ? "page" : undefined}
            aria-expanded={x === "More" ? moreOpen : undefined}
            aria-controls={x === "More" ? "mobile-more-dialog" : undefined}
            aria-haspopup={x === "More" ? "dialog" : undefined}
            onClick={() => {
              if (x === "More") return setMoreOpen((open) => !open);
              setMoreOpen(false);
              closeDetail();
              if (x === "Inbox") setInboxTab("tasks");
              setView(x);
            }}
          >
            <span className="mobileNavIcon" aria-hidden="true"><ViewIcon name={x} /></span><span>{tr(x)}</span>
          </button>
        ))}
      </nav>
      {!moreOpen && <button className="mobileCaptureButton" type="button" onClick={() => openCapture()} aria-label={tr("quickCapture")} title={tr("quickCapture")}>＋</button>}
      {moreOpen && (
        <div className="mobileMoreBackdrop" onClick={() => setMoreOpen(false)}>
          <div id="mobile-more-dialog" className="mobileMore" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title" ref={moreDialogRef} onClick={(e) => e.stopPropagation()} onKeyDown={(event) => handleOverlayKeys(event, () => setMoreOpen(false))}>
            <div className="mobileMoreHeader">
              <span className="mobileMoreHandle" aria-hidden="true" />
              <h2 id="mobile-more-title">{tr("More")}</h2>
              <button type="button" className="mobileMoreClose" aria-label={tr("closeMenu")} title={tr("closeMenu")} onClick={() => setMoreOpen(false)}><span aria-hidden="true">×</span></button>
            </div>
            {mobileMoreGroups.map((group) => (
              <section className="mobileMoreGroup" key={group.title} aria-labelledby={`mobile-more-${group.title}`}>
                <h3 id={`mobile-more-${group.title}`}>{tr(group.title)}</h3>
                {group.views.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`mobileMoreItem${view === item ? " active" : ""}`}
                    data-nav-view={item}
                    aria-current={view === item ? "page" : undefined}
                    onClick={() => {
                      setView(item);
                      closeDetail();
                      setMoreOpen(false);
                    }}
                  >
                    <span className="mobileMoreItemIcon" aria-hidden="true"><ViewIcon name={item} /></span>
                    <span>{tr(item)}</span>
                  </button>
                ))}
              </section>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
