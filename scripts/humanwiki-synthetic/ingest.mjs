// Offline H1-synthetic laboratory. This module is intentionally unreachable from app/lib routes.
import { createHash } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const fail = message => { throw new Error(`Synthetic import: ${message}`); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const plainObject = value => object(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const nonempty = value => typeof value === "string" && value.length > 0 && value.length <= 200;
const compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function messageText(content, format) {
  if (format === "chatgpt-mapping-v1") {
    if (!object(content) || content.content_type !== "text" || !Array.isArray(content.parts) ||
      content.parts.length !== 1 || typeof content.parts[0] !== "string") fail("unsupported ChatGPT content shape");
    return content.parts[0];
  }
  if (!Array.isArray(content) || content.length !== 1 || !object(content[0]) ||
    content[0].type !== "text" || typeof content[0].text !== "string") fail("unsupported Claude content shape");
  return content[0].text;
}

function segments(text, speaker) {
  if (text.length > 8192) fail("message text exceeds 8192 characters");
  const lines = text.split(/\r?\n/);
  // A Markdown quote is third-party or unknown even when embedded in an owner turn.
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    const quoted = /^\s*>/.test(line);
    const body = quoted ? line.replace(/^\s*>\s?/, "") : line;
    return [{ segment: index, text: body, speaker: quoted ? "unknown" : speaker,
      provenance: quoted ? "quoted_third_party" :
      speaker === "user" ? "owner_statement" : speaker === "assistant" ? "assistant_generated" : "unknown" }];
  });
}

export function parseSyntheticBundle(bundle) {
  if (!object(bundle) || bundle.synthetic_fixture !== true || !nonempty(bundle.source_id) ||
    !["chatgpt-mapping-v1", "claude-chat-v1"].includes(bundle.format) || !Array.isArray(bundle.conversations)) {
    fail("unsupported or non-synthetic bundle");
  }
  const bytes = Buffer.byteLength(JSON.stringify(bundle));
  if (bytes > 262144 || bundle.conversations.length > 50) fail("bundle limit exceeded");
  const messages = [];
  const seen = new Set();
  const seenConversations = new Set();
  for (const conversation of bundle.conversations) {
    if (!object(conversation) || !nonempty(conversation.id)) fail("conversation has no stable id");
    if (seenConversations.has(conversation.id)) fail("duplicate conversation id within bundle");
    seenConversations.add(conversation.id);
    let entries;
    if (bundle.format === "chatgpt-mapping-v1") {
      if (!object(conversation.mapping)) fail("unsupported ChatGPT mapping");
      entries = [];
      for (const [nodeId, node] of Object.entries(conversation.mapping)) {
        if (!nonempty(nodeId) || !object(node) || !Object.hasOwn(node, "message"))
          fail("malformed ChatGPT mapping node");
        if (node.message === null) {
          // The sole supported non-message node is a declared structural root.
          if (node.parent !== null || nodeId !== "root") fail("unexpected null ChatGPT message");
          continue;
        }
        entries.push(node.message);
      }
    } else {
      entries = Array.isArray(conversation.chat_messages) ? conversation.chat_messages : fail("unsupported Claude messages");
    }
    for (const message of entries) {
      if (!object(message) || !nonempty(message.id)) fail("message has no stable id");
      const speaker = bundle.format === "chatgpt-mapping-v1" ? message.author?.role : message.sender;
      if (typeof speaker !== "string" || !["user", "assistant", "system", "tool", "human"].includes(speaker)) fail("unsupported speaker role");
      const normalizedSpeaker = speaker === "human" ? "user" : speaker;
      const text = messageText(message.content, bundle.format);
      const timestamp = bundle.format === "chatgpt-mapping-v1" ? message.create_time : message.created_at;
      if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) fail("invalid message time");
      const key = JSON.stringify([bundle.source_id, conversation.id, message.id]);
      if (seen.has(key)) fail("duplicate message id within bundle");
      seen.add(key);
      messages.push({ conversation_id: conversation.id, message_id: message.id, speaker: normalizedSpeaker,
        observed_at: new Date(timestamp).toISOString(), segments: segments(text, normalizedSpeaker) });
      if (messages.length > 1000) fail("message limit exceeded");
    }
  }
  messages.sort((a, b) => compareIds(a.conversation_id, b.conversation_id) || compareIds(a.message_id, b.message_id));
  const digest = sha(JSON.stringify(bundle));
  return { source_id: bundle.source_id, format: bundle.format, digest, messages };
}

export function advanceSyntheticImport(parsed, prior = undefined, maxMessages = Infinity) {
  if (!parsed || !nonempty(parsed.source_id) || !Array.isArray(parsed.messages) ||
    !(maxMessages === Infinity || (Number.isSafeInteger(maxMessages) && maxMessages >= 0))) fail("invalid run input");
  if (prior !== undefined && !plainObject(prior)) fail("invalid checkpoint object");
  const state = prior !== undefined ? structuredClone(prior) : { schema: 2, source_id: parsed.source_id,
    bundle_digest: parsed.digest, next_message: 0, records: [] };
  if (state.schema !== 2 || state.source_id !== parsed.source_id || state.bundle_digest !== parsed.digest ||
    !Number.isSafeInteger(state.next_message) || state.next_message < 0 ||
    state.next_message > parsed.messages.length || !Array.isArray(state.records)) fail("checkpoint mismatch");
  // A cursor from a truncated or edited checkpoint must never skip records on resume.
  if (prior !== undefined) {
    const expected = advanceSyntheticImport(parsed, undefined, state.next_message);
    if (JSON.stringify(state) !== JSON.stringify(expected)) fail("checkpoint records do not match cursor");
  }
  const ids = new Set(state.records.map(record => record.id));
  const end = Math.min(parsed.messages.length, state.next_message + maxMessages);
  for (let index = state.next_message; index < end; index++) {
    const message = parsed.messages[index];
    for (const segment of message.segments) {
      const locator = { source_id: parsed.source_id, conversation_id: message.conversation_id,
        message_id: message.message_id, segment: segment.segment };
      const id = sha(JSON.stringify(locator));
      if (ids.has(id)) fail("duplicate locator in checkpoint");
      state.records.push({ id, locator, observed_at: message.observed_at, speaker: segment.speaker,
        enclosing_message_speaker: message.speaker,
        provenance: segment.provenance, content_sha256: sha(segment.text), text: segment.text,
        review: "proposed", freshness: "current", disputed: false, sensitivity: "unclassified",
        scope: "owner_private_unassigned" });
      ids.add(id);
    }
    // Caller persists this whole state atomically; cursor and records never commit separately.
    state.next_message = index + 1;
  }
  return state;
}
