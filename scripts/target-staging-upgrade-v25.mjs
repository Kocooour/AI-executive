/** Explicit staging-only v25 → v26 upgrade. Never run automatically. */
import path from 'node:path';
import {upgradeTargetStagingV25} from '../lib/target-staging-schema-upgrade.ts';
const usage='usage: target-staging-upgrade-v25.mjs --directory <absolute staging directory> --generation <restore generation>';
try {
  const args=process.argv.slice(2);
  if (args.length===1 && args[0]==='--help') process.stdout.write(usage+'\n');
  else {
    if(args.length!==4) throw Error();
    const options=new Map();
    for(let i=0;i<args.length;i+=2) {
      if(!['--directory','--generation'].includes(args[i]) || options.has(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw Error();
      options.set(args[i],args[i+1]);
    }
    const directory=options.get('--directory'), generation=options.get('--generation');
    if(!directory || !path.isAbsolute(directory) || !generation) throw Error();
    const result=upgradeTargetStagingV25({stagingDirectory:directory,expectedRestoreGeneration:generation});
    process.stdout.write(JSON.stringify(result));
    process.exitCode=result.ok ? 0 : result.reason==='confirm_untrusted' ? 2 : 1;
  }
} catch {
  process.stderr.write(usage+'\n');
  process.exitCode=1;
}
