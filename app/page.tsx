import { LumiAppRoot } from "./ui/lumi-app-root";
import { TargetDataProvider } from "./ui/target-data-provider";
import { targetUiEnabled } from "../lib/target-staging-session-generation";
import { targetUiConfig } from "../lib/target-ui-config";

// R3-FE-1/2: the flags are read per request. When they are off (default) the app is
// rendered exactly as before: no provider, no runtime, no config, no additional request.
export const dynamic = "force-dynamic";

export default function Page() {
  // The provider (and its session check) mounts only when a target screen is
  // actually enabled; R3-FE-1 alone has no consumer and makes no request.
  const config = targetUiEnabled() ? targetUiConfig(process.env) : null;
  // R3-FE-3: the provider also mounts for the global scope switcher alone.
  const targetData = config?.myPlan.enabled === true || config?.scopes.enabled === true;
  return targetData
    ? <TargetDataProvider><LumiAppRoot targetMyPlan={config?.myPlan} targetScopes={config?.scopes} /></TargetDataProvider>
    : <LumiAppRoot />;
}
