#!/usr/bin/env node
/** Explicit first-release C-3b external consent fence provision/check.
 * Run only under deploy-safe.sh, as ai-executive, with the service stopped.
 * This command does NOT grant consent. Missing file on --check fails closed. */
import {provisionInboxAIFenceFile,INBOX_AI_FENCE_PRODUCTION_PATH}
  from "../lib/target-inbox-ai-consent-fence.ts";
import path from "node:path";

const usage="usage: target-inbox-ai-fence-provision.mjs --provision|--check --directory /var/lib/ai-executive-target/personal-v1";
const args=process.argv.slice(2);
const mode=args[0]==="--provision"?"provision":args[0]==="--check"?"check":null;
const dir=args[1]==="--directory"?args[2]:null;
const expected="/var/lib/ai-executive-target/personal-v1";
if(args.length!==3||!mode||dir!==expected||!path.isAbsolute(dir)||
   INBOX_AI_FENCE_PRODUCTION_PATH!=="/var/lib/ai-executive-target/inbox-ai-consent-fence.sqlite"){
  process.stderr.write(usage+"\n");
  process.exitCode=1;
}else{
  const ok=provisionInboxAIFenceFile(dir,mode);
  process.stdout.write(JSON.stringify({ok,mode})+"\n");
  process.exitCode=ok?0:1;
}
