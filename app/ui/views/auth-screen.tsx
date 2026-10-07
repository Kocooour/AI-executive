"use client";
import type { LumiApp } from "../use-lumi-app";

export function AuthScreen({ app }: { app: LumiApp }) {
  const {
    authError,
    authNotice,
    authPassword,
    authState,
    checkAccess,
    login,
    passkeyBusy,
    passkeySupported,
    setAuthPassword,
    signInWithPasskey,
    tr,
  } = app;
  return (
    <>
      <main className="authShell">
        <form className="authCard" onSubmit={login}>
          <div className="authMark">◇</div>
          <p className="eyebrow">LUMI</p>
          <h1>
            {authState === "checking"
              ? tr("checkingAccess")
              : authState === "misconfigured"
                ? tr("setupRequired")
                : authState === "unavailable"
                  ? tr("accessUnavailable")
                : tr("signIn")}
          </h1>
          {authState === "required" && (
            <>
              <label>
                {tr("password")}
                <input
                  autoFocus
                  type="password"
                  autoComplete="current-password"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                />
              </label>
              <button type="submit" disabled={!authPassword}>{tr("signIn")}</button>
              {passkeySupported && (
                <button
                  className="secondaryAction"
                  type="button"
                  disabled={passkeyBusy}
                  onClick={signInWithPasskey}
                >
                  {passkeyBusy ? tr("checking") : tr("signInPasskey")}
                </button>
              )}
            </>
          )}
          {authNotice && <p className="authNotice" role="alert">{authNotice}</p>}
          {authError && <p className="authError" role="alert">{authError}</p>}
          {authState === "unavailable" && (
            <>
              <p className="authError" role="alert">{tr("accessUnavailableDetail")}</p>
              <button type="button" onClick={() => void checkAccess()}>{tr("retry")}</button>
            </>
          )}
        </form>
      </main>
    </>
  );
}
