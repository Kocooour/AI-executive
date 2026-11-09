import { LumiAppRoot } from "./ui/lumi-app-root";
import { TargetDataProvider } from "./ui/target-data-provider";
import { targetUiEnabled } from "../lib/target-staging-session-generation";

// R3-FE-1: the flag is read per request. When it is off (default) the app is
// rendered exactly as before: no provider, no runtime, no additional request.
export const dynamic = "force-dynamic";

export default function Page() {
  const targetData = targetUiEnabled();
  return targetData
    ? <TargetDataProvider><LumiAppRoot /></TargetDataProvider>
    : <LumiAppRoot />;
}
