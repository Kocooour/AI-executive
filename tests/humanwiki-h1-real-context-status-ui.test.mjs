import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHumanWikiSourceStatus } from "../lib/humanwiki-source-status-ui.ts";
import { HumanWikiSourceStatusPanel } from "../app/ui/humanwiki-source-status-panel.tsx";

const empty = {
  result: "source_intent_and_witness_observation_not_authorization",
  witnessState: "signed_witness_prefix_covers_owner_intents",
  sources: {
    chatgpt_user_export: { revision: 0, latestIntent: null },
    claude_user_export: { revision: 0, latestIntent: null },
  },
  importAuthorized: false,
  consentVerified: false,
  independentWitnessVerified: false,
  withdrawalComplete: false,
  realImportEnabled: false,
  claimsCreated: 0,
};
const withChange = (updates) => ({ ...empty, ...updates });

test("strict client validation retains only minimal owner-scoped status", () => {
  assert.deepEqual(parseHumanWikiSourceStatus(empty), {
    witnessState: "signed_witness_prefix_covers_owner_intents",
    sources: empty.sources,
  });
  const pending = withChange({
    witnessState: "signed_witness_prefix_lags_owner_intents",
    sources: {
      chatgpt_user_export: { revision: 1, latestIntent: "withdrawal_requested" },
      claude_user_export: { revision: 2, latestIntent: "grant_requested" },
    },
  });
  assert.deepEqual(parseHumanWikiSourceStatus(pending)?.sources, pending.sources);
});

test("malformed, privileged and foreign content never reaches the UI projection", () => {
  const malformed = [
    null, [], 42, "ready",
    withChange({ importAuthorized: true }),
    withChange({ consentVerified: true }),
    withChange({ withdrawalComplete: true }),
    withChange({ independentWitnessVerified: true }),
    withChange({ realImportEnabled: true }),
    withChange({ claimsCreated: 1 }),
    withChange({ witnessState: "signed_remote_head_matches_local" }),
    withChange({ witnessState: "unknown" }),
    withChange({ digest: "a".repeat(64) }),
    withChange({ sources: { ...empty.sources, foreign_user: { revision: 1, latestIntent: "withdrawal_requested" } } }),
    withChange({ sources: { ...empty.sources, chatgpt_user_export: { revision: 1, latestIntent: null } } }),
    withChange({ sources: { ...empty.sources, chatgpt_user_export: { revision: 0, latestIntent: "grant_requested" } } }),
    withChange({ sources: { ...empty.sources, chatgpt_user_export: { revision: -1, latestIntent: "withdrawal_requested" } } }),
    withChange({ sources: { ...empty.sources, chatgpt_user_export: { revision: 1.5, latestIntent: "withdrawal_requested" } } }),
    withChange({ sources: { ...empty.sources, chatgpt_user_export: { revision: 1, latestIntent: "owner_claim" } } }),
    withChange({ sources: { ...empty.sources, chatgpt_user_export: { revision: 1, latestIntent: "withdrawal_requested", sourceId: "secret" } } }),
    withChange({ sources: { chatgpt_user_export: empty.sources.chatgpt_user_export } }),
    withChange({ result: "import_authorized" }),
  ];
  for (const input of malformed) {
    assert.equal(parseHumanWikiSourceStatus(input), null, JSON.stringify(input));
  }
});

test("SSR displays only an explicit manual check, never cached owner information", () => {
  for (const language of ["cs", "en"]) {
    const output = renderToStaticMarkup(
      React.createElement(HumanWikiSourceStatusPanel, { language }),
    );
    assert.match(output, /humanwiki-source-status/);
    assert.match(output, language === "cs" ? /Ověřit stav zdrojů/ : /Check source status/);
    assert.doesNotMatch(output, /chatgpt_user_export|signed_witness_prefix_|owner-alice/);
    assert.doesNotMatch(output, /type="(?:file|submit)"|<form/);
  }
});

test("main Context view mounts status only behind both server flags and drops it on view exit", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const context = readFileSync(new URL("../app/ui/views/context-view.tsx", import.meta.url), "utf8");
  const root = readFileSync(new URL("../app/ui/lumi-app-root.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../app/ui/humanwiki-source-status-panel.tsx", import.meta.url), "utf8");
  assert.match(page, /AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_UI_ENABLED === "true" &&/);
  assert.match(page, /AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_STATUS_ENABLED === "true"/);
  assert.match(context, /view === "Context" &&/);
  assert.match(context, /humanWikiSourceStatusEnabled && <HumanWikiSourceStatusPanel/);
  assert.match(context, /key={app\.activeWorkspaceId}/);
  assert.match(root, /humanWikiSourceStatusEnabled={humanWikiSourceStatusEnabled}/);
  assert.match(panel, /cache: "no-store"/);
  assert.match(panel, /credentials: "same-origin"/);
  assert.match(panel, /AbortController/);
  assert.match(panel, /visibilitychange/);
  assert.match(panel, /pagehide/);
  assert.match(panel, /window\.addEventListener\("blur"/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
});
