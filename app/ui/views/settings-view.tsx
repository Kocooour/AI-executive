"use client";
import { useEffect, useRef } from "react";
import { type DurableContextItem, type Language, type ThemeMode } from "../types";
import { views } from "../navigation";
import type { LumiApp } from "../use-lumi-app";

const settingsTabLabels: Record<string, string> = {
  general: "settingsGeneral", workspace: "workspace", access: "access", notifications: "settingsNotifications",
  calendar: "settingsCalendar", data: "settingsData", context: "settingsContext",
};

export function SettingsView({ app }: { app: LumiApp }) {
  const {
    setSettingsSection,
    settingsSection: requestedSection,
    askConfirm,
    activeWorkspaceId,
    attentionTaskCount,
    authEnabled,
    backupStatus,
    backups,
    badgeStatus,
    calendarAction,
    calendarBusy,
    calendarLabel,
    calendarSources,
    calendarStatus,
    calendarUrl,
    contextAction,
    contextBusy,
    contextContent,
    contextProjectId,
    contextScope,
    contextSensitivity,
    contextStatus,
    contextTitle,
    createServerBackup,
    createWorkspace,
    disableNotifications,
    durableContext,
    enableNotifications,
    items,
    language,
    logout,
    logoutBusy,
    logoutError,
    newWorkspaceDraft,
    notificationState,
    notificationStatus,
    passkeyBusy,
    passkeyLabel,
    passkeyPassword,
    passkeyStatus,
    passkeySupported,
    passkeys,
    registerPasskey,
    removePasskey,
    restoreAppBadge,
    restoreServerBackup,
    saveLanguage,
    saveNotificationSettings,
    saveTheme,
    saveWorkspaceName,
    scopedItems,
    scopedRelations,
    selectWorkspace,
    selectWriteWorkspace,
    setCalendarLabel,
    setCalendarUrl,
    setContextContent,
    setContextProjectId,
    setContextScope,
    setContextSensitivity,
    setContextTitle,
    setNewWorkspaceDraft,
    setNotificationState,
    setPasskeyLabel,
    setPasskeyPassword,
    setSettingsSaved,
    setStartupView,
    setWorkspaceDraft,
    settingsSaved,
    standalone,
    startupView,
    syncStatus,
    testAppBadge,
    testNotification,
    themeMode,
    tr,
    view,
    workspaceDraft,
    workspaces,
    writeWorkspace,
    writeWorkspaceId,
  } = app;
  // Access exists only with sign-in enabled; never leave the page without a visible section.
  const settingsSection = requestedSection === "access" && !authEnabled ? "general" : requestedSection;
  // On narrow screens the row scrolls sideways: keep the current section's button in sight when
  // Settings opens on a section chosen elsewhere. Only the row moves, never the page.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = tabsRef.current;
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !current) return;
    const left = current.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + current.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = Math.max(0, left - 16);
  }, [view, settingsSection]);
  return (
    <>
          {view === "Settings" && (
            <div className="settingsPanel">
              <div className="settingsTabs" role="navigation" aria-label={tr("settingsSections")} ref={tabsRef}>
                {(["general", "workspace", ...(authEnabled ? ["access"] : []), "notifications", "calendar", "data", "context"] as const).map((name) => (
                  <button key={name} type="button" aria-current={settingsSection === name ? "page" : undefined} onClick={() => setSettingsSection(name)}>
                    {tr(settingsTabLabels[name])}
                  </button>
                ))}
              </div>
              <section hidden={settingsSection !== "general"}>
                <h2>{tr("settingsGeneral")}</h2>
                <label>
                  {tr("language")}
                  <select
                    value={language}
                    onChange={(event) => saveLanguage(event.target.value as Language)}
                  >
                    <option value="cs">{tr("czech")}</option>
                    <option value="en">{tr("english")}</option>
                  </select>
                </label>
                <label>
                  {tr("appearance")}
                  <select
                    value={themeMode}
                    onChange={(event) => saveTheme(event.target.value as ThemeMode)}
                  >
                    <option value="system">{tr("systemTheme")}</option>
                    <option value="light">{tr("lightTheme")}</option>
                    <option value="dark">{tr("darkTheme")}</option>
                  </select>
                </label>
                <label>
                  {tr("openStartup")}
                  <select
                    value={startupView}
                    onChange={(e) => {
                      setStartupView(e.target.value);
                      localStorage.setItem(
                        "ai-executive-startup-view",
                        e.target.value,
                      );
                    }}
                  >
                    {views
                      .filter((item) => item !== "Home")
                      .map((item) => (
                        <option key={item} value={item}>{tr(item)}</option>
                      ))}
                  </select>
                </label>
              </section>
              <section hidden={settingsSection !== "general"}>
                <h2>{tr("installApp")}</h2>
                <p>
                  {standalone
                    ? tr("installedApp")
                    : tr("installHelp")}
                </p>
                <span className={`installStatus ${standalone ? "installed" : ""}`}>
                  {standalone ? tr("installed") : tr("browserMode")}
                </span>
                <div className="badgeDiagnostics">
                  <h3>{tr("appBadge")}</h3>
                  <dl>
                    <div>
                      <dt>{tr("installApp")}</dt>
                      <dd>{standalone ? tr("installed") : tr("browserMode")}</dd>
                    </div>
                    <div>
                      <dt>{tr("notificationPermission")}</dt>
                      <dd>{typeof Notification !== "undefined" && Notification.permission === "granted" ? tr("allowed") : tr("notAllowed")}</dd>
                    </div>
                    <div>
                      <dt>{tr("badgeApi")}</dt>
                      <dd>{typeof navigator !== "undefined" && typeof (navigator as Navigator & { setAppBadge?: unknown }).setAppBadge === "function" ? tr("supported") : tr("unsupported")}</dd>
                    </div>
                    <div>
                      <dt>{tr("currentBadgeCount")}</dt>
                      <dd>{attentionTaskCount}</dd>
                    </div>
                  </dl>
                  <div className="notificationActions">
                    <button className="primaryAction" onClick={testAppBadge}>{tr("testBadge")}</button>
                    <button onClick={restoreAppBadge}>{tr("restoreBadge")}</button>
                  </div>
                  {badgeStatus && <p role="status">{badgeStatus}</p>}
                  <p className="settingsHint">{tr("badgeSystemHint")}</p>
                </div>
              </section>
              <section hidden={settingsSection !== "workspace"}>
                <h2>{tr("workspace")}</h2>
                <label>
                  {tr("currentView")}
                  <select
                    value={activeWorkspaceId}
                    onChange={(event) => selectWorkspace(event.target.value)}
                  >
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.workspaceId}>
                        {workspace.title}
                      </option>
                    ))}
                    <option value="all">{tr("allWork")}</option>
                  </select>
                </label>
                {activeWorkspaceId === "all" && (
                  <label>
                    {tr("createIn")}
                    <select
                      value={writeWorkspaceId}
                      onChange={(event) => selectWriteWorkspace(event.target.value)}
                    >
                      {workspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.workspaceId}>
                          {workspace.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  {tr("workspaceName")}
                  <div className="workspaceNameEditor">
                    <input
                      value={workspaceDraft}
                      maxLength={120}
                      onChange={(e) => {
                        setWorkspaceDraft(e.target.value);
                        setSettingsSaved(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveWorkspaceName();
                      }}
                      aria-label="Workspace name"
                    />
                    <button
                      onClick={saveWorkspaceName}
                      disabled={!workspaceDraft.trim()}
                    >
                      {tr("save")}
                    </button>
                  </div>
                </label>
                {settingsSaved && (
                  <p className="saveConfirmation" role="status">
                    {tr("workspaceSaved")}
                  </p>
                )}
                <div className="workspaceSummary">
                  <span>
                    {String(writeWorkspace?.properties.kind || "personal")} workspace
                  </span>
                  <span>
                    {tr("role")}: {String(writeWorkspace?.properties.role || "owner")}
                  </span>
                </div>
                <label>
                  {tr("newWorkspace")}
                  <div className="workspaceNameEditor">
                    <input
                      value={newWorkspaceDraft}
                      maxLength={120}
                      onChange={(event) => setNewWorkspaceDraft(event.target.value)}
                      placeholder="Family or Work"
                      aria-label="New workspace name"
                    />
                    <button
                      onClick={createWorkspace}
                      disabled={!newWorkspaceDraft.trim()}
                    >
                      {tr("create")}
                    </button>
                  </div>
                </label>
                <p>
                  Shared workspaces are ready for separate data and roles. Inviting
                  another account will be enabled after multi-user identity is added.
                </p>
              </section>
              {authEnabled && (
                <section hidden={settingsSection !== "access"}>
                  <h2>{tr("access")}</h2>
                  <p>{tr("ownerSession")}</p>
                  {passkeySupported && (
                    <>
                      <label>
                        {tr("passkeyName")}
                        <input
                          value={passkeyLabel}
                          maxLength={80}
                          onChange={(event) => setPasskeyLabel(event.target.value)}
                          placeholder="Kryštof’s iPhone"
                        />
                      </label>
                      <label>
                        {tr("confirmPassword")}
                        <input
                          type="password"
                          autoComplete="current-password"
                          value={passkeyPassword}
                          maxLength={1024}
                          onChange={(event) => setPasskeyPassword(event.target.value)}
                        />
                      </label>
                      <button
                        className="primaryAction"
                        onClick={registerPasskey}
                        disabled={passkeyBusy || !passkeyLabel.trim() || !passkeyPassword}
                      >
                        {passkeyBusy ? tr("waitingDevice") : tr("addPasskey")}
                      </button>
                      <div className="passkeyList">
                        {passkeys.map((passkey) => (
                          <div key={passkey.id} className="passkeyRow">
                            <span>
                              <strong>{passkey.label}</strong>
                              <small>
                                {passkey.rpId} · added {new Date(passkey.createdAt).toLocaleDateString()}
                                {passkey.backedUp ? " · synced" : ""}
                              </small>
                            </span>
                            <button onClick={() => removePasskey(passkey.id)}>{tr("remove")}</button>
                          </div>
                        ))}
                      </div>
                      {passkeyStatus && <p role="status">{passkeyStatus}</p>}
                      <p>
                        Passkeys are tied to this address. Use the same HTTPS address on
                        iPhone and Mac for an iCloud-synced passkey.
                      </p>
                    </>
                  )}
                  <button className="secondaryAction" onClick={logout} aria-disabled={logoutBusy}>{tr(logoutBusy ? "signingOut" : "signOut")}</button>
                  <p>{tr("signOutInfo")}</p>
                  {logoutError && <p role="alert" className="formError">{logoutError}</p>}
                </section>
              )}
              <section hidden={settingsSection !== "notifications"}>
                <div className="sectionHeading">
                  <div>
                    <h2>{tr("reminders")}</h2>
                    <p>{tr("reminderInfo")}</p>
                  </div>
                  <span className={`installStatus ${notificationState?.subscriptionCount ? "installed" : ""}`}>
                    {notificationState?.subscriptionCount
                      ? `${notificationState.subscriptionCount} ${tr("devices")}`
                      : tr("noDevice")}
                  </span>
                </div>
                <div className="notificationActions">
                  <button className="primaryAction" onClick={enableNotifications}>{tr("enableDevice")}</button>
                  <button onClick={testNotification}>{tr("sendTest")}</button>
                  <button onClick={disableNotifications}>{tr("disableDevice")}</button>
                </div>
                {notificationState && (
                  <div className="preferenceGrid">
                    <label className="preferenceToggle">
                      <input
                        type="checkbox"
                        checked={notificationState.preferences.enabled}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          enabled: event.target.checked,
                        })}
                      />
                      {tr("scheduledReminders")}
                    </label>
                    <label className="preferenceToggle">
                      <input
                        type="checkbox"
                        checked={notificationState.preferences.attentionPush !== false}
                        disabled={!notificationState.preferences.enabled}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          attentionPush: event.target.checked,
                        })}
                      />
                      <span>{tr("attentionPush")}<small>{tr("attentionPushInfo")}</small></span>
                    </label>
                    <label>
                      {tr("timezone")}
                      <input
                        value={notificationState.preferences.timezone}
                        onChange={(event) => setNotificationState({
                          ...notificationState,
                          preferences: { ...notificationState.preferences, timezone: event.target.value },
                        })}
                        onBlur={() => saveNotificationSettings(notificationState.preferences)}
                      />
                    </label>
                    <label>
                      {tr("workdayStarts")}
                      <input
                        type="time"
                        value={notificationState.preferences.workdayStart}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          workdayStart: event.target.value,
                        })}
                      />
                    </label>
                    <label>
                      {tr("workdayEnds")}
                      <input
                        type="time"
                        value={notificationState.preferences.workdayEnd}
                        onChange={(event) => saveNotificationSettings({
                          ...notificationState.preferences,
                          workdayEnd: event.target.value,
                        })}
                      />
                    </label>
                    <fieldset>
                      <legend>{tr("workingDays")}</legend>
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => (
                        <label key={label}>
                          <input
                            type="checkbox"
                            checked={notificationState.preferences.workdays.includes(day)}
                            onChange={() => {
                              const workdays = notificationState.preferences.workdays.includes(day)
                                ? notificationState.preferences.workdays.filter((value) => value !== day)
                                : [...notificationState.preferences.workdays, day].sort();
                              saveNotificationSettings({ ...notificationState.preferences, workdays });
                            }}
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                  </div>
                )}
                {notificationStatus && <p role="status">{notificationStatus}</p>}
              </section>
              <section hidden={settingsSection !== "calendar"}>
                <div className="sectionHeading">
                  <div>
                    <h2>{tr("calendarReadonly")}</h2>
                    <p>{tr("calendarInfo")}</p>
                  </div>
                  <span className={`installStatus ${calendarSources.some((source) => source.status === "ready") ? "installed" : ""}`}>
                    {calendarSources.some((source) => source.status === "ready") ? tr("readOnly") : tr("notConnected")}
                  </span>
                </div>
                <div className="calendarConnect">
                  <label>
                    {tr("sourceName")}
                    <input value={calendarLabel} maxLength={120} onChange={(event) => setCalendarLabel(event.target.value)} />
                  </label>
                  <label>
                    {tr("privateIcs")}
                    <input type="password" autoComplete="off" value={calendarUrl} maxLength={8192}
                      placeholder="https://…/calendar.ics"
                      onChange={(event) => setCalendarUrl(event.target.value)} />
                  </label>
                  <button className="primaryAction" disabled={calendarBusy || !calendarLabel.trim() || !calendarUrl.trim()}
                    onClick={() => calendarAction("connect")}>{tr("connectLoad")}</button>
                </div>
                <div className="calendarSources">
                  {calendarSources.map((source) => (
                    <div key={source.id}>
                      <span>
                        <strong>{source.label}</strong>
                        <small>
                          {source.status === "ready" ? `${source.eventCount} ${tr("events")}` : tr("syncFailed")}
                          {source.lastSuccessAt ? ` · ${tr("lastSync")} ${new Date(source.lastSuccessAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}` : ""}
                        </small>
                        {source.lastError && <small role="status">{source.lastError}</small>}
                      </span>
                      <div className="notificationActions">
                        <button disabled={calendarBusy} onClick={() => calendarAction("refresh", source.id)}>{tr("refresh")}</button>
                        <button disabled={calendarBusy} onClick={async () => {
                          if (await askConfirm({ title: tr("calendarDisconnectTitle"), message: tr("calendarDisconnectConfirm").replace("{label}", () => source.label), confirmLabel: tr("disconnect"), danger: true })) calendarAction("disconnect", source.id);
                        }}>{tr("disconnect")}</button>
                      </div>
                    </div>
                  ))}
                </div>
                {calendarStatus && <p role="status">{calendarStatus}</p>}
              </section>
              <section hidden={settingsSection !== "data"}>
                <h2>{tr("dataAi")}</h2>
                <p>
                  {tr("workspaceDataInfo")}
                </p>
                <dl>
                  <div>
                    <dt>{tr("storedItems")}</dt>
                    <dd>{scopedItems.length}</dd>
                  </div>
                  <div>
                    <dt>{tr("relations")}</dt>
                    <dd>{scopedRelations.length}</dd>
                  </div>
                  <div>
                    <dt>{tr("serverSync")}</dt>
                    <dd className={`syncStatus ${syncStatus}`}>
                      {syncStatus === "synced"
                        ? tr("synced")
                        : syncStatus === "syncing"
                          ? tr("syncing")
                          : syncStatus === "offline"
                            ? tr("offline")
                            : tr("connecting")}
                    </dd>
                  </div>
                </dl>
              </section>
              <section hidden={settingsSection !== "data"}>
                <div className="sectionHeading">
                  <div>
                    <h2>{tr("backups")}</h2>
                    <p>{tr("backupInfo")}</p>
                  </div>
                  <button className="primaryAction" onClick={createServerBackup}>
                    {tr("createBackup")}
                  </button>
                </div>
                {backupStatus && <p role="status">{backupStatus}</p>}
                <div className="backupList">
                  {backups.length === 0 && <p>{tr("noBackups")}</p>}
                  {backups.slice(0, 8).map((backup) => (
                    <div key={backup.name}>
                      <span>
                        <strong>{new Date(backup.createdAt).toLocaleString()}</strong>
                        <small>
                          {backup.error
                            ? `Invalid backup · ${backup.error}`
                            : `${backup.entityCount} ${tr("items")} · ${backup.relationCount} ${tr("relations").toLowerCase()}`}
                        </small>
                      </span>
                      <button
                        disabled={Boolean(backup.error)}
                        onClick={() => restoreServerBackup(backup)}
                      >
                        {tr("restore")}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
              <section className="durableContextSection" hidden={settingsSection !== "context"}>
                <div className="sectionHeading"><div><h2>{language === "cs" ? "Kontext Lumi" : "Lumi context"}</h2><p>{language === "cs" ? "Trvalé informace a pravidla, která má Lumi používat. Citlivý kontext se neposílá externím AI službám." : "Durable facts and rules for Lumi. Sensitive context is not sent to external AI services."}</p></div></div>
                <div className="contextForm">
                  <div className="preferenceGrid">
                    <label>{language === "cs" ? "Rozsah" : "Scope"}<select value={contextScope} onChange={(e) => setContextScope(e.target.value as DurableContextItem["scope"])}><option value="me">Me</option><option value="work">Work</option><option value="family">Family</option><option value="rules">Rules</option><option value="workspace">Workspace</option><option value="project">Project</option></select></label>
                    <label>{language === "cs" ? "Citlivost" : "Sensitivity"}<select value={contextSensitivity} onChange={(e) => setContextSensitivity(e.target.value as DurableContextItem["sensitivity"])}><option value="normal">{language === "cs" ? "Běžný" : "Normal"}</option><option value="sensitive">{language === "cs" ? "Citlivý" : "Sensitive"}</option></select></label>
                  </div>
                  {contextScope === "project" && <label>{tr("project")}<select value={contextProjectId} onChange={(e) => setContextProjectId(e.target.value)}><option value="">—</option>{items.filter((item) => item.type === "project" && item.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId)).map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>}
                  <label>{language === "cs" ? "Název" : "Title"}<input maxLength={200} value={contextTitle} onChange={(e) => setContextTitle(e.target.value)} placeholder={language === "cs" ? "Např. Jak plánuji pracovní den" : "e.g. How I plan my workday"} /></label>
                  <label>{language === "cs" ? "Obsah" : "Content"}<textarea maxLength={10000} value={contextContent} onChange={(e) => setContextContent(e.target.value)} placeholder={language === "cs" ? "Informace, preference nebo pravidlo…" : "Fact, preference or rule…"} /></label>
                  <div className="notificationActions"><button onClick={() => contextAction("create")} disabled={contextBusy || !contextTitle.trim() || !contextContent.trim() || (contextScope === "project" && !contextProjectId)}>{contextBusy ? tr("working") : tr("save")}</button></div>
                  {contextStatus && <p className="saveConfirmation" role="status">{contextStatus}</p>}
                </div>
                <div className="contextItems">
                  {durableContext.map((item) => <article key={item.id}><div><strong>{item.title}</strong><small>{item.scope} · {item.sensitivity === "sensitive" ? (language === "cs" ? "citlivý" : "sensitive") : (language === "cs" ? "běžný" : "normal")}</small><p>{item.content}</p></div><button className="textAction danger" onClick={() => contextAction("archive", item.id)} disabled={contextBusy}>{language === "cs" ? "Archivovat" : "Archive"}</button></article>)}
                  {!durableContext.length && <p>{language === "cs" ? "Zatím není uložen žádný trvalý kontext." : "No durable context saved yet."}</p>}
                </div>
              </section>
            </div>
          )}
    </>
  );
}
