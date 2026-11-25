// Test harness only, explicitly preloaded by the isolated Playwright E-1 run.
 // No production route, environment override, or application clock is added.
const fs=require("node:fs");
const path=require("node:path");
const cp=require("node:child_process");
const {syncBuiltinESMExports}=require("node:module");
const clock=process.env.LUMI_E2E_ATTENTION_CLOCK;
const data=process.env.AI_EXECUTIVE_DATA_DIR;
if(process.env.AI_EXECUTIVE_E2E!=="true"||!clock||!data||
   path.basename(clock)!=="attention-clock.json"||
   !path.basename(path.dirname(clock)).startsWith("lumi-e2e-")||
   path.resolve(data)!==path.join(path.dirname(clock),"data")){
  throw Error("E-1 clock requires the isolated browser-test directory");
}
const fixed=()=>{
  const n=JSON.parse(fs.readFileSync(clock,"utf8"));
  if(!Number.isSafeInteger(n)||n<=0)throw Error("Invalid E-1 test clock");
  return n;
};
Date.now=fixed;
// The staging subprocess launcher deliberately strips ambient NODE_OPTIONS.
// Inject the same test-only preload into its attention children in THIS test
// process, without weakening production subprocess environment allowlists.
const spawn=cp.spawn;
cp.spawn=function(file,args,options){
  if(Array.isArray(args)&&args.some(a=>typeof a==="string"&&
    /[/\\]target-staging-attention(?:-command-(?:preview|write|receipt))?-child\.mjs$/.test(a))&&
    options?.env?.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY===path.join(path.dirname(clock),"target-store")&&
    options.env.AI_EXECUTIVE_DATA_DIR===data){
    options={...options,env:{...options.env,AI_EXECUTIVE_E2E:"true",
      LUMI_E2E_ATTENTION_CLOCK:clock,NODE_OPTIONS:"--require="+JSON.stringify(__filename)}};
  }
  return spawn.call(this,file,args,options);
};
syncBuiltinESMExports();
