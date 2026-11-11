// Synthetic-only concurrency helper: coordinate through test-owned files.
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {TargetStagingSessionAuthority} from '../../lib/target-staging-session-authority.ts';
const [storePath,readyPath,goPath,resultPath] = process.argv.slice(2);
const {store,command,actor = 'alice',durableHash} = JSON.parse(readFileSync(storePath,'utf8'));
const authority = new TargetStagingSessionAuthority(store);
try {
  const issued = authority.issueWritable(actor);
  if (!issued) throw Error('cannot issue test credential');
  writeFileSync(readyPath,'ready');
  const deadline = Date.now()+10000;
  while (!existsSync(goPath)) {
    if (Date.now()>deadline) throw Error('barrier timeout');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  writeFileSync(resultPath,JSON.stringify(authority.updateProjectTitle(issued.sessionToken,command,actor,durableHash)));
} finally {authority.close()}
