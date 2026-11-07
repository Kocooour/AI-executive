"use client";
import { handleOverlayKeys } from "../focus";
import { mobileDesignV1Preview, mobileMoreGroups, mobileV1MoreGroups, mobileV1MoreViews, mobileV1Tabs, mobileViews, moreViews } from "../navigation";
import type { LumiApp } from "../use-lumi-app";
import { ViewIcon } from "./project-icon";

export function MobileNav({ app }: { app: LumiApp }) {
  const {
    closeDetail,
    language,
    mobilePlanPreviewActive,
    moreDialogRef,
    moreOpen,
    moreTriggerRef,
    markMobileMoreNavigation,
    openCapture,
    setMoreOpen,
    setInboxTab,
    setView,
    tr,
    view,
  } = app;
  const tabs: readonly string[] = mobileDesignV1Preview ? mobileV1Tabs : mobileViews;
  const groups = mobileDesignV1Preview ? mobileV1MoreGroups : mobileMoreGroups;
  const secondary = mobileDesignV1Preview ? mobileV1MoreViews : moreViews;
  return (
    <>
      <nav className="mobileNav" data-design-preview={mobileDesignV1Preview ? "lumi-v1" : undefined}>
        {tabs.map((x) => {
          const planPreview = mobileDesignV1Preview && x === "MyPlanPreview";
          const label = planPreview ? (language === "cs" ? "Můj plán" : "My Plan") : tr(x);
          const current = planPreview ? view === "Today" && mobilePlanPreviewActive
            : x === "More" ? secondary.includes(view) && !(view === "Today" && mobilePlanPreviewActive)
            : view === x;
          return (
          <button
            key={x}
            ref={x === "More" ? moreTriggerRef : undefined}
            className={(x === "More" && moreOpen) || (!moreOpen && current) ? "active" : ""}
            aria-label={planPreview ? (language === "cs" ? "Můj plán – vývojový náhled nad stávajícími daty" : "My Plan – development preview with legacy data") : label}
            data-nav-view={planPreview ? "Today" : x}
            data-nav-tab={planPreview ? "my-plan-preview" : x}
            aria-current={!moreOpen && current ? "page" : undefined}
            aria-expanded={x === "More" ? moreOpen : undefined}
            aria-controls={x === "More" ? "mobile-more-dialog" : undefined}
            aria-haspopup={x === "More" ? "dialog" : undefined}
            onClick={() => {
              if (x === "More") return setMoreOpen((open) => !open);
              setMoreOpen(false);
              closeDetail();
              if (x === "Inbox") setInboxTab("tasks");
              setView(planPreview ? "Today" : x, planPreview ? { previewMyPlan: true } : undefined);
            }}
          >
            <span className="mobileNavIcon" aria-hidden="true"><ViewIcon name={planPreview ? "Today" : x} /></span><span>{label}</span>
          </button>
        );})}
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
            {groups.map((group) => (
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
                      markMobileMoreNavigation(item);
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
