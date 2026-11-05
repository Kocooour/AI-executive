"use client";
import { useEffect, useState } from "react";
import { pluralText } from "../../../lib/plural";
import { planItemsOutsideToday, planMinutesForTasks, roundedPlanHours } from "../../../lib/today-plan";
import { pickSummarySuggestion } from "../../../lib/today-summary";
import { buildMyPlanPreview } from "../../../lib/my-plan-preview";
import { mobileDesignV1Preview } from "../navigation";
import { inSentenceDate } from "../format";
import type { LumiApp } from "../use-lumi-app";
import { PopoverMenu } from "./popover-menu";
import { CalendarEventNotice } from "./calendar-event-actions";
import { DayTimeline } from "./day-timeline";
import { WorkNowCard } from "./work-now-card";

// Today is one list. These are the parts around it (the list itself is EntityList): the count and
// planned time next to the date with the "⋯" options menu, the strip above the list and the footer.

// Per workspace; the value is the day the suggestion was hidden for.
const hiddenKey = (workspaceId: string) => `lumi-today-summary-hidden:${workspaceId}`;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((result, [name, value]) => result.replace(`{${name}}`, () => String(value)), text);

export function TodayHeaderMeta({ app }: { app: LumiApp }) {
  const { calendarToday, calendarWorkspaceSelection, collection, dayPlanBusy, language, loadDayPlan, priorityFilter, setDayPlanNow, setDayPlanStatus,
    setPriorityFilter, setSortBy, sortBy, todayTasks, tr, visibleDayPlan } = app;
  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  // The count and the planned time are those of the rows shown; with a priority filter the count says
  // how many of all Today tasks. Without a plan the time is left out.
  const shown = collection.filter((task) => task.type === "task");
  const minutes = planMinutesForTasks(visibleDayPlan, new Set(shown.map((task) => task.id)));
  const hours = minutes ? roundedPlanHours(minutes) : 0;
  const planPreviewActive = mobileDesignV1Preview && app.mobilePlanPreviewActive;
  const previewDays = planPreviewActive ? buildMyPlanPreview({
    entities: app.items, relations: app.scopedRelations,
    workspaceId: app.activeWorkspaceId, today: app.today, priorityFilter, sortBy,
  }) : null;
  const summary = planPreviewActive
    ? app.activeWorkspaceId === "all"
      ? (language === "cs" ? "Vyberte prostor" : "Select a workspace")
      : `${language === "cs" ? "Dnes" : "Today"}: ${previewDays?.[0]?.count ?? 0} · ${language === "cs" ? "Zítra" : "Tomorrow"}: ${previewDays?.[1]?.count ?? 0}`
    : [
    priorityFilter !== "all" && shown.length !== todayTasks.length
      ? fill(tr("todayFilteredCount"), { shown: shown.length, total: todayTasks.length })
      : pluralText(language, shown.length, tr("todayTaskForms")),
    hours > 0 ? fill(tr("todayApproxHours"), { hours: hours.toLocaleString(locale, { maximumFractionDigits: 1 }) }) : "",
  ].filter(Boolean).join(" · ");
  return (
    <>
      <span className="todaySummary" data-today-summary>{summary}</span>
      <PopoverMenu role="group" className="todayOptions" label={tr("todayMenuLabel")} triggerLabel={tr("todayMenu")}
        triggerClassName="todayOptionsButton" triggerData={{ "data-today-menu": "" }} triggerContent={<span aria-hidden="true">⋯</span>}>
        {() => (
          <div className="todayOptionsBody">
            <div className="listControls">
              <label>
                {tr("priority")}
                <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
                  <option value="all">{tr("all")}</option>
                  <option value="high">{tr("high")}</option>
                  <option value="medium">{tr("medium")}</option>
                  <option value="low">{tr("low")}</option>
                  <option value="none">{tr("none")}</option>
                </select>
              </label>
              <label>
                {tr("sort")}
                <select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
                  <option value="manual">{tr("manual")}</option>
                  <option value="date">{tr("date")}</option>
                  <option value="priority">{tr("priority")}</option>
                  <option value="created">{tr("newest")}</option>
                </select>
              </label>
            </div>
            <button type="button" className="todayRefresh" disabled={dayPlanBusy} onClick={() => loadDayPlan(calendarWorkspaceSelection.current, calendarToday)
              .then(() => { setDayPlanNow(Date.now()); setDayPlanStatus(tr("dayPlanRefreshed")); })
              .catch((error) => setDayPlanStatus(error instanceof Error ? error.message : tr("dayPlanChanged")))}>{tr("dayPlanRefresh")}</button>
          </div>
        )}
      </PopoverMenu>
    </>
  );
}

// A running work session, today's calendar events (only with a connected calendar) and the plan's
// status line with Undo.
export function TodayTop({ app }: { app: LumiApp }) {
  const { calendarDayEvents, calendarFresh, calendarSources, currentDayPlanBlock, dayPlanBusy, dayPlanStatus, dayPlanUndo, nextDayPlanBlock,
    tr, undoDayPlanBlock, visibleDayPlan } = app;
  const planPreview = mobileDesignV1Preview && app.mobilePlanPreviewActive;
  const canUndo = Boolean(visibleDayPlan && dayPlanUndo?.workspaceId === visibleDayPlan.workspaceId && dayPlanUndo.date === visibleDayPlan.date);
  const stripShowsStale = calendarDayEvents.length > 0 && !calendarFresh;
  // The plan's own calendar state, said once for the whole list (the rows only show their times).
  // No calendar at all is the single quiet line in the footer.
  const planState = !visibleDayPlan ? ""
    : visibleDayPlan.calendar === "non-workday" ? "dayPlanNonWorkday"
      : visibleDayPlan.calendar === "stale" ? (stripShowsStale ? "" : "dayPlanStale")
        : visibleDayPlan.calendar === "missing" ? (calendarSources.length === 0 ? "" : "dayPlanMissing") : "";
  const state = (block: { existing?: boolean; planningSource?: string }) =>
    tr(block.existing ? block.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting" : "dayPlanProposed");
  const overloaded = Boolean(visibleDayPlan && visibleDayPlan.calendar === "ready" && visibleDayPlan.overloaded);
  return (
    <>
      <WorkNowCard app={app} compact />
      {/* Outside the calendar section: the event that became a task may have been the day's last one. */}
      <CalendarEventNotice app={app} />
      {planPreview && calendarDayEvents.length > 0 && (
        <h2 className="myPlanV1EventsTitle">
          <span className="myPlanV1EventIcon" aria-hidden="true">▦</span>
          {app.language === "cs" ? "Dnešní události" : "Today's events"}
        </h2>
      )}
      <DayTimeline app={app} mode="today" />
      {(planState || overloaded || currentDayPlanBlock || nextDayPlanBlock) && (
        <div className="todayPlanState" data-today-plan-state>
          {planState && <p role="status">{tr(planState)}</p>}
          {overloaded && visibleDayPlan && <p role="status" className="dayPlanWarning">{tr("dayPlanOverloaded")} ({visibleDayPlan.requiredMinutes} min)</p>}
          {currentDayPlanBlock && <p data-plan-current><strong>{tr("dayPlanCurrent")}:</strong> {currentDayPlanBlock.title} · {state(currentDayPlanBlock)}</p>}
          {nextDayPlanBlock && <p data-plan-next><strong>{tr("dayPlanNext")}:</strong> {nextDayPlanBlock.title} · {state(nextDayPlanBlock)}</p>}
        </div>
      )}
      {(dayPlanStatus || canUndo) && (
        <div className="todayPlanNote">
          {dayPlanStatus && <p role="status">{dayPlanStatus}</p>}
          {canUndo && <button type="button" disabled={dayPlanBusy} onClick={undoDayPlanBlock}>{tr("dayPlanUndo")}</button>}
        </div>
      )}
    </>
  );
}

export function TodayFooter({ app }: { app: LumiApp }) {
  const { activeWorkspaceId, calendarSources, calendarToday, collection, deferBusy, deferTask, items, language,
    setView, today, todayTasks, tr, visibleDayPlan } = app;
  // Hidden for the day: kept in this browser per workspace, and in memory when storage is unavailable.
  const [hiddenHere, setHiddenHere] = useState<string[]>([]);
  const [reviewedProposal, setReviewedProposal] = useState<string | null>(null);
  useEffect(() => { setReviewedProposal(null); },
    [activeWorkspaceId, today, app.mobilePlanPreviewActive]);
  const storedHidden = (() => { try { return localStorage.getItem(hiddenKey(activeWorkspaceId)) || ""; } catch { return ""; } })();
  const hiddenDay = storedHidden === today || hiddenHere.includes(`${activeWorkspaceId}|${today}`) ? today : "";
  const todayIds = new Set(todayTasks.map((task) => task.id));

  // Plan items for tasks that are not planned for today are not rows; one quiet line counts them.
  const openIds = new Set(items.filter((item) => item.type === "task" && item.status === "open").map((item) => item.id));
  const outside = planItemsOutsideToday(visibleDayPlan, todayIds, openIds);
  const outsideKey = outside === 1 ? "todayOutsideOne" : new Intl.PluralRules(language === "cs" ? "cs" : "en").select(outside) === "few" ? "todayOutsideFew" : "todayOutsideOther";

  // At most one summary suggestion. The aggregate is read-only, so it has none.
  const calendarOverloaded = Boolean(visibleDayPlan && visibleDayPlan.calendar === "ready" && visibleDayPlan.overloaded &&
    visibleDayPlan.date === calendarToday && calendarToday === today);
  const picked = activeWorkspaceId === "all" || hiddenDay === today ? null : pickSummarySuggestion({
    ordered: collection.filter((task) => task.type === "task"),
    todayCount: todayTasks.length,
    openTasks: items.filter((item) => item.type === "task" && item.status === "open" && item.workspaceId === activeWorkspaceId),
    today,
    calendarOverloaded,
  });
  const proposalKey = picked ? `${picked.task.id}:${picked.suggestion.target}` : null;
  const previewProposal = mobileDesignV1Preview && app.mobilePlanPreviewActive;
  const proposalReviewed = previewProposal && proposalKey !== null && reviewedProposal === proposalKey;
  const sentence = picked && fill(tr(picked.suggestion.reason), {
    todayCount: picked.suggestion.params.todayCount,
    date: inSentenceDate(String(picked.suggestion.params.date), language),
    dayCount: picked.suggestion.params.dayCount,
  });
  const hide = () => {
    setHiddenHere((current) => [...current, `${activeWorkspaceId}|${today}`]);
    try { localStorage.setItem(hiddenKey(activeWorkspaceId), today); } catch { /* storage unavailable: hidden until reload */ }
  };

  const noCalendar = calendarSources.length === 0;
  if (outside === 0 && !picked && !noCalendar) return null;
  return (
    <footer className="todayFooter">
      {outside > 0 && (
        <p className="todayOutside" data-today-outside>{fill(tr(outsideKey), { n: outside })} — <button type="button" className="textAction" onClick={() => setView("Home")}>{tr("todayOutsideLink")}</button></p>
      )}
      {picked && sentence && (
        <section className="todaySuggestion"
          aria-label={mobileDesignV1Preview && app.mobilePlanPreviewActive
            ? (language === "cs" ? "Návrh Lumi" : "Lumi proposal") : tr("todaySuggestLabel")}
          data-today-suggestion={picked.task.id}>
          <p>
            <span className="deferLumi"><span aria-hidden="true">✦ </span>{mobileDesignV1Preview && app.mobilePlanPreviewActive
              ? (language === "cs" ? "Návrh Lumi" : "Lumi proposal") : tr("deferLumi")}:</span> {sentence}{" "}
            <b>{fill(tr("todaySuggestMove"), { title: picked.task.title || tr("untitledItem"), date: picked.suggestion.target === "someday" ? tr("scheduleSomeday") : inSentenceDate(picked.suggestion.target, language) })}</b>
          </p>
          <div className="todaySuggestionActions">
            {previewProposal && !proposalReviewed ? (
              <button type="button" className="primaryAction" data-plan-proposal-review=""
                onClick={() => setReviewedProposal(proposalKey)}>
                {language === "cs" ? "Posoudit" : "Review"}
              </button>
            ) : (
              <>
                {previewProposal && (
                  <p className="myPlanV1ProposalImpact" data-plan-proposal-impact>
                    {language === "cs"
                      ? "Dopad: úkol bude přeplánován a aktualizují se jeho značky Dnes, Večer nebo Doručené. Termín, prostor, Oblast a ostatní úkoly se nemění."
                      : "Impact: reschedules this task and updates its Today, Evening or Inbox markers. Its deadline, workspace, Area and other tasks stay unchanged."}
                  </p>
                )}
                <button type="button" className="primaryAction" disabled={deferBusy}
                  data-plan-proposal-approve={previewProposal ? picked.task.id : undefined}
                  onClick={() => void deferTask(picked.task, picked.suggestion.target, "lumi")}>
                  {previewProposal ? (language === "cs" ? "Schválit" : "Approve") : tr("deferApply")}
                </button>
                <button type="button" data-plan-proposal-reject={previewProposal ? picked.task.id : undefined}
                  onClick={hide}>
                  {previewProposal ? (language === "cs" ? "Odmítnout" : "Reject") : tr("todaySuggestHide")}
                </button>
              </>
            )}
          </div>
        </section>
      )}
      {noCalendar && <p className="homeNotice todayCalendarNote">{tr("calendarDisconnectedNote")} <button type="button" className="textAction" onClick={() => setView("Calendar")}>{tr("homeConnectCalendar")}</button></p>}
    </footer>
  );
}
