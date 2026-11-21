/** C-3a: short-lived actor-bound target Inbox read; no legacy fallback. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try {
  const [rawLimit,encodedCursor,extra]=process.argv.slice(2);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  const cursor=encodedCursor==="_"?null:
    typeof encodedCursor==="string"&&/^[A-Za-z0-9_-]{1,2048}$/.test(encodedCursor)
      ?Buffer.from(encodedCursor,"base64url").toString("utf8"):null;
  if(extra!==undefined||!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit||"")||
      !encodedCursor||(encodedCursor!=="_"&&(
        cursor===null||Buffer.from(cursor).toString("base64url")!==encodedCursor||
        Buffer.byteLength(cursor)>512||!cursor.trim()||/[\u0000-\u001f\u007f]/u.test(cursor)))||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED!=="true"||
      !stagingDirectory||!path.isAbsolute(stagingDirectory)||
      !expectedRestoreGeneration||!ownerUserId)throw Error("unavailable");
  const authority=new TargetStagingSessionAuthority({stagingDirectory,expectedRestoreGeneration});
  try {
    const resolved=resolveChildActor({stagingDirectory,expectedRestoreGeneration,ownerUserId});
    const page=resolved&&authority.readInboxPage(resolved.actor,Number(rawLimit),cursor);
    if(!page)throw Error("unavailable");
    process.stdout.write(JSON.stringify({ok:true,...page}));
  } finally {authority.close();}
} catch {process.exitCode=1;}
