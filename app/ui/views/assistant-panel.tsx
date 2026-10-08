"use client";
import type { LumiApp } from "../use-lumi-app";

export function AssistantPanel({ app }: { app: LumiApp }) {
  const {
    aiBusy,
    aiText,
    askAI,
    assistantOpen,
    context,
    messages,
    resolveAIProposal,
    setAiText,
    setAssistantOpen,
    tr,
    undoAIAction,
    workspaceName,
  } = app;
  return (
    <>
      {assistantOpen && (
        <div className="assistantPanel">
          <div className="assistantHead">
            <b>{tr("assistant")}</b>
            <button onClick={() => setAssistantOpen(false)}>×</button>
          </div>
          <div className="assistantContext">
            {context
              ? tr("assistantContextFocus").replace("{workspace}", workspaceName).replace("{focus}", context.focus.title)
              : tr("assistantContextServer").replace("{workspace}", workspaceName)}
          </div>
          <div className="assistantMessages">
            {messages.length === 0 && (
              <div className="assistantWelcome">
                <p>{tr("assistantWelcome")}</p>
                <button onClick={() => askAI("Co dnes hoří?")} disabled={aiBusy}>
                  {tr("todayBrief")}
                </button>
                <small>{tr("assistantWritesConfirm")}</small>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={"assistantTurn " + m.role}>
                <div className={"msg " + m.role}>{m.content}</div>
                {m.proposal && (
                  <div className={`aiProposal ${m.resolved ? "resolved" : ""}`}>
                    <strong>{m.proposal.summary}</strong>
                    <dl>
                      {m.proposal.changes.map((change) => (
                        <div key={`${change.label}:${change.value}`}>
                          <dt>{change.label}</dt>
                          <dd>{change.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {!m.resolved && (
                      <div className="aiProposalActions">
                        <button
                          className="primaryAction"
                          disabled={aiBusy}
                          onClick={() => resolveAIProposal(m.proposal!.id, "confirm")}
                        >
                          {tr("confirm")}
                        </button>
                        <button
                          disabled={aiBusy}
                          onClick={() => resolveAIProposal(m.proposal!.id, "cancel")}
                        >
                          {tr("cancel")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {m.actionId && !m.resolved && (
                  <button className="aiUndo" disabled={aiBusy} onClick={() => undoAIAction(m.actionId!)}>
                    {tr("undoAi")}
                  </button>
                )}
              </div>
            ))}
            {aiBusy && <p className="assistantThinking">{tr("working")}</p>}
          </div>
          <div className="assistantComposer">
            <input
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") askAI();
              }}
              placeholder={`${tr("askAi")}…`}
              disabled={aiBusy}
            />
            <button onClick={() => askAI()} disabled={aiBusy || !aiText.trim()}>{tr("send")}</button>
          </div>
        </div>
      )}
    </>
  );
}
