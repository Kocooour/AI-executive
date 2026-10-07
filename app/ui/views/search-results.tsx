"use client";
import type { LumiApp } from "../use-lumi-app";

export function SearchResults({ app }: { app: LumiApp }) {
  const {
    inspect,
    query,
    scopedItems,
    scopedRelations,
    tr,
    view,
  } = app;
  return (
    <>
          {view === "Search" && query && (
            <div className="searchResults">
              {scopedItems
                .filter((x) => {
                  const q = query.toLowerCase(),
                    linked = scopedRelations
                      .filter(
                        (r) =>
                          r.sourceEntityId === x.id ||
                          r.targetEntityId === x.id,
                      )
                      .flatMap((r) => [
                        scopedItems.find((i) => i.id === r.sourceEntityId)?.title ||
                          "",
                        scopedItems.find((i) => i.id === r.targetEntityId)?.title ||
                          "",
                      ])
                      .join(" ");
                  return (x.title + " " + (x.content || "") + " " + linked)
                    .toLowerCase()
                    .includes(q);
                })
                .map((x) => (
                  <article key={x.id} onClick={() => inspect(x)}>
                    <div>
                      <strong>{x.title}</strong>
                      <small>{tr(x.type)}</small>
                    </div>
                  </article>
                ))}
            </div>
          )}
    </>
  );
}
