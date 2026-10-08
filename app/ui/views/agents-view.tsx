"use client";
import type { LumiApp } from "../use-lumi-app";

export function AgentsView({ app }: { app: LumiApp }) {
  const {
    agentBusyId,
    agentResult,
    agentRuns,
    agentStatus,
    language,
    pactAgents,
    runPACTAgent,
    tr,
    view,
  } = app;
  return (
    <>
          {view === "Agents" && (
            <div className="agentsPanel">
              <p className="agentsIntro">{tr("agentsIntro")}</p>
              <div className="agentGrid">
                {pactAgents.map((agent) => {
                  const latest = agentRuns.find((run) => run.agentId === agent.id);
                  const description = agent.id === "project-manager"
                    ? (language === "cs" ? "Najde rizikové projekty a projekty bez dalšího kroku." : "Finds at-risk projects and projects without a next action.")
                    : (language === "cs" ? "Připraví podklady k nejbližší události z kalendáře." : "Prepares guidance for the next calendar event.");
                  const displayName = agent.id === "project-manager"
                    ? (language === "cs" ? "Projektový manažer" : "Project Manager")
                    : (language === "cs" ? "Příprava na schůzku" : "Meeting Prep");
                  return (
                    <article className="agentCard" key={agent.id}>
                      <header>
                        <span className="agentGlyph" aria-hidden="true">◇</span>
                        <div><h2>{displayName}</h2><small>v{agent.version} · {agent.triggerModes.map((mode) => tr(`triggerMode_${mode}`)).join(" / ")}</small></div>
                      </header>
                      <p>{description}</p>
                      <div className="agentMeta">
                        <span>{tr("agentRead").replace("{count}", String(agent.tools.filter((tool) => tool.endsWith(".read") || tool.includes("calendar")).length))}</span>
                        {agent.tools.some((tool) => tool.endsWith(".propose")) && <span>{tr("agentPropose")}</span>}
                        <span>{tr("agentNoWrite")}</span>
                      </div>
                      {latest && <small>{tr("latestResult")}: {latest.status === "completed" ? tr("completedRun") : latest.status === "failed" ? tr("failedRun") : tr("runningRun")} · {new Date(latest.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</small>}
                      <button className="primaryAction" disabled={Boolean(agentBusyId) || !agent.triggerModes.includes("manual")} onClick={() => runPACTAgent(agent.id)}>
                        {agentBusyId === agent.id ? tr("working") : tr("runAgent")}
                      </button>
                    </article>
                  );
                })}
              </div>
              {agentResult && (
                <section className="agentResult" aria-live="polite">
                  <div className="sectionHeading"><div><p className="eyebrow">{tr("latestResult")}</p><h2>{agentResult.title}</h2></div><small>{new Date(agentResult.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</small></div>
                  <p>{agentResult.summary}</p>
                  <h3>{tr("recommendations")}</h3>
                  <ol>{agentResult.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}</ol>
                  <p className="agentSafetyNote">{language === "cs" ? "Agent nic nezměnil. Případné změny se nejprve zobrazí jako návrh k potvrzení." : "The agent changed nothing. Any mutation is shown as a proposal for confirmation first."}</p>
                </section>
              )}
              {agentStatus && <p className="saveConfirmation" role="status">{agentStatus}</p>}
              <section className="agentHistory">
                <div className="sectionHeading"><div><h2>{tr("runHistory")}</h2><p>{language === "cs" ? "Sanitizovaný provozní záznam bez názvů úkolů a obsahu kontextu." : "Sanitized operational history without task titles or context contents."}</p></div></div>
                <div className="agentRunList">
                  {agentRuns.map((run) => {
                    const agent = pactAgents.find((candidate) => candidate.id === run.agentId);
                    return <article key={run.id}><span className={`runStatus ${run.status}`}>{run.status === "completed" ? "✓" : run.status === "failed" ? "!" : "…"}</span><div><strong>{agent?.name || run.agentId}</strong><small>{run.triggerMode} · {new Date(run.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</small><p>{run.status === "completed" ? tr("completedRun") : run.status === "failed" ? tr("failedRun") : tr("runningRun")}</p>{run.outputSummary && <small className="runSummary">{run.outputSummary.split(";").join(" · ")}</small>}</div></article>;
                  })}
                  {!agentRuns.length && <p>{tr("noAgentRuns")}</p>}
                </div>
              </section>
            </div>
          )}
    </>
  );
}
