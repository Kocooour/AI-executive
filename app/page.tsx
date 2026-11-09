import { LumiAppRoot } from "./ui/lumi-app-root";
import { TargetDataProvider } from "./ui/target-data-provider";
import { targetUiEnabled } from "../lib/target-staging-session-generation";
import { targetUiConfig } from "../lib/target-ui-config";

// R3-FE-1/2: the flags are read per request. When they are off (default) the app is
// rendered exactly as before: no provider, no runtime, no config, no additional request.
export const dynamic = "force-dynamic";

export default function Page() {
  const targetData = targetUiEnabled();
  const config = targetData ? targetUiConfig(process.env) : null;
  return targetData
    ? <TargetDataProvider><LumiAppRoot targetMyPlan={config?.myPlan} /></TargetDataProvider>
    : <LumiAppRoot />;
}
