"use client";
import { useState } from "react";
import { searchWorkspaceItems, type SearchKind } from "../../../lib/search-views";
import type { LumiApp } from "../use-lumi-app";
import { RecordMarks } from "./held-back";

const kinds: SearchKind[] = ["all", "task", "project", "area", "note"];
const labels: Record<SearchKind, string> = {
  all: "searchKindAll", task: "task", project: "project", area: "area", note: "note",
};

export function SearchResults({ app }: { app: LumiApp }) {
  const { activeWorkspaceId, inspect, query, scopedItems, scopedRelations, tr, view } = app;
  const [kind, setKind] = useState<SearchKind>("all");
  if (view !== "Search") return null;
  const term = query.trim();
  const hits = searchWorkspaceItems(scopedItems, scopedRelations, term);
  const results = kind === "all" ? hits : hits.filter(hit => hit.entity.type === kind);
  const count = (value: SearchKind) => value === "all"
    ? hits.length : hits.filter(hit => hit.entity.type === value).length;
  return (
    <section className="searchExplorer" aria-label={tr("searchResultsLabel")} data-search-scope={activeWorkspaceId}>
      {!term ? (
        <p className="searchState" role="status">{tr("searchStartHint")}</p>
      ) : (
        <>
          <div className="searchSummary" role="status" aria-live="polite">
            {tr("searchFound").replace("{count}", String(results.length))}
          </div>
          <div className="searchKindFilters" role="group" aria-label={tr("searchTypeFilter")}>
            {kinds.map(value => (
              <button type="button" key={value} data-search-kind={value}
                aria-pressed={kind === value} onClick={() => setKind(value)}>
                {tr(labels[value])} <span aria-hidden="true">{count(value)}</span>
              </button>
            ))}
          </div>
          {results.length ? (
            <div className="searchResults" role="list">
              {results.map(({ entity, match }) => (
                <article role="listitem" key={entity.id} data-result-type={entity.type} data-match-source={match}>
                  <button type="button" className="searchResultOpen" onClick={() => void inspect(entity)}
                    aria-label={tr("searchOpenItem").replace("{title}", entity.title || tr("untitledItem"))}>
                    <span className="searchResultText">
                      <strong>{entity.title || tr("untitledItem")}<RecordMarks app={app} entity={entity}/></strong>
                      <small>{tr(entity.type)}{match !== "title" && ` · ${tr(match === "content" ? "searchMatchContent" : "searchMatchRelated")}`}</small>
                    </span>
                    <span className="searchResultArrow" aria-hidden="true">→</span>
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="searchState" role="status">
              <p>{tr("searchNoMatches")}</p>
              {kind !== "all" && <button type="button" onClick={() => setKind("all")}>{tr("searchClearType")}</button>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
