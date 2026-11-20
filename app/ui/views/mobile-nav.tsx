"use client";
import dynamic from "next/dynamic";
import { handleOverlayKeys } from "../focus";
import { mobileDesignV1Preview, mobileMoreGroups, mobileV1MoreGroups, mobileV1MoreViews, mobileV1Tabs, mobileViews, moreViews } from "../navigation";
import type { LumiApp } from "../use-lumi-app";
import { ViewIcon } from "./project-icon";
import { targetMobileMoreCurrentViews, type ShellNavigationModel } from "../../../lib/target-shell-views";
const TargetInboxCount = dynamic(() => import("../target-inbox").then(m=>m.TargetInboxCount), { ssr: false });

export function MobileNav({ app, navigation, targetPlan = false, onTargetCapture, targetIncludesTasks = false }: {
  app: LumiApp; navigation?:ShellNavigationModel; targetPlan?: boolean; onTargetCapture?:()=>void; targetIncludesTasks?:boolean;
}) {
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
  const personalV1=Boolean(navigation?.personalV1);
  const tabs: readonly string[] = mobileDesignV1Preview ? mobileV1Tabs : mobileViews;
  const groups = mobileDesignV1Preview ? mobileV1MoreGroups : mobileMoreGroups;
  const secondary = personalV1 && navigation
    ? [...navigation.archive,...targetMobileMoreCurrentViews(navigation),"Agents","Settings"]
    : mobileDesignV1Preview ? mobileV1MoreViews : moreViews;
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
            aria-label={planPreview ? (targetPlan
              ? (language === "cs" ? "Můj plán – aktuální úkoly ze serveru" : "My Plan – current tasks from the server")
              : (language === "cs" ? "Můj plán – vývojový náhled nad stávajícími daty" : "My Plan – development preview with legacy data")) : label}
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
            <span className="mobileNavIcon" aria-hidden="true"><ViewIcon name={planPreview ? "MyPlanPreview" : mobileDesignV1Preview && x === "Projects" ? "ProjectsV1" : x} /></span><span>{label}</span>
          </button>
        );})}
      </nav>
      {/* The target action never falls back to the legacy CaptureDialog. */}
      {!moreOpen && (!app.captureDisabled || onTargetCapture) && <button
        className="mobileCaptureButton" type="button"
        data-target-private-capture-fab={onTargetCapture?"mobile":undefined}
        onClick={onTargetCapture ?? (()=>openCapture())}
        aria-label={onTargetCapture?(targetIncludesTasks?(language==="cs"?"Rychlé přidání":"Quick capture"):(language==="cs"?"Nová soukromá poznámka":"New private note")):tr("quickCapture")}
        title={onTargetCapture?(targetIncludesTasks?(language==="cs"?"Rychlé přidání":"Quick capture"):(language==="cs"?"Nová soukromá poznámka":"New private note")):tr("quickCapture")}>＋</button>}
      {moreOpen && (
        <div className="mobileMoreBackdrop" onClick={() => setMoreOpen(false)}>
          <div id="mobile-more-dialog" className="mobileMore" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title" ref={moreDialogRef} onClick={(e) => e.stopPropagation()} onKeyDown={(event) => handleOverlayKeys(event, () => setMoreOpen(false))}>
            <div className="mobileMoreHeader">
              <span className="mobileMoreHandle" aria-hidden="true" />
              <h2 id="mobile-more-title">{tr("More")}</h2>
              <button type="button" className="mobileMoreClose" aria-label={tr("closeMenu")} title={tr("closeMenu")} onClick={() => setMoreOpen(false)}><span aria-hidden="true">×</span></button>
            </div>
            {!personalV1 && groups.map((group) => (
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
                    <span className="mobileMoreItemIcon" aria-hidden="true"><ViewIcon name={mobileDesignV1Preview && item === "Today" ? "TodayV1" : item} /></span>
                    <span>{tr(item)}</span>
                    {moreOpen && item==="Inbox" && navigation.byView.Inbox==="primary" && <TargetInboxCount />}
                  </button>
                ))}
              </section>
            ))}
            {personalV1 && navigation && <>
              <section className="mobileMoreGroup" data-testid="target-more-primary"
                aria-labelledby="target-more-current-heading">
                <h3 id="target-more-current-heading">{language==="cs"?"Aktuální pohledy":"Current views"}</h3>
                {targetMobileMoreCurrentViews(navigation).map(item=>
                  <button key={item} type="button" className="mobileMoreItem"
                    data-nav-view={item} aria-current={view===item?"page":undefined}
                    onClick={()=>{markMobileMoreNavigation(item);setView(item);closeDetail();setMoreOpen(false);}}>
                    <span className="mobileMoreItemIcon" aria-hidden="true"><ViewIcon name={item} /></span>
                    <span>{tr(item)}</span>
                  </button>)}
              </section>
              <section className="mobileMoreGroup targetArchiveSection"
                data-testid="target-archive-mobile" aria-labelledby="target-more-archive-heading">
                <h3 id="target-more-archive-heading">
                  {language==="cs"?"Archiv (stará data, jen pro čtení)":"Archive (old data, read-only)"}
                </h3>
                <p>{language==="cs"
                  ?"Staré položky jsou oddělené od aktuálních dat a nelze je upravovat."
                  :"Historical items are separate from current data and cannot be edited."}</p>
                {navigation.archive.map(item=>
                  <button key={item} type="button" className="mobileMoreItem"
                    data-nav-view={item} data-nav-archive="true"
                    aria-current={view===item&&!(item==="Today"&&mobilePlanPreviewActive)?"page":undefined}
                    onClick={()=>{markMobileMoreNavigation(item);setView(item);closeDetail();setMoreOpen(false);}}>
                    <span className="mobileMoreItemIcon" aria-hidden="true">
                      <ViewIcon name={item==="Today"?"TodayV1":item} />
                    </span><span>{tr(item==="LegacyHome"?"Home":item==="LegacyUpcoming"?"Upcoming":item==="LegacyInbox"?"Inbox":item)}</span>
                  </button>)}
              </section>
              <section className="mobileMoreGroup" aria-labelledby="target-more-system-heading">
                <h3 id="target-more-system-heading">{tr("mobileMoreSystem")}</h3>
                {["Agents","Settings"].map(item=>
                  <button key={item} type="button" className="mobileMoreItem"
                    data-nav-view={item} aria-current={view===item?"page":undefined}
                    onClick={()=>{markMobileMoreNavigation(item);setView(item);closeDetail();setMoreOpen(false);}}>
                    <span className="mobileMoreItemIcon" aria-hidden="true"><ViewIcon name={item} /></span>
                    <span>{tr(item)}</span>
                  </button>)}
              </section>
            </>}
          </div>
        </div>
      )}
    </>
  );
}
