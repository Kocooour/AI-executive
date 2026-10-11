"use client";
import { useEffect, useRef, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { fetchClientAuthStatus } from "../../../lib/client-auth-status";
import { failWhileOffline, watchSession } from "../../../lib/session-watch";
import { localizeServerError } from "../../../lib/server-errors";

// Signing in: the access check on start, sign-in with the password or a passkey, and returning to
// the sign-in screen when the session ends. Moved verbatim from use-lumi-app.tsx. What happens
// with the data after signing in, and whether the user has just signed out, belong to the sync
// part of the app and are passed in as `afterSignIn` and `isSignedOut`.
export function useSignIn({ tr, language, answerConfirm, isSignedOut, afterSignIn }: {
  tr: (key: string) => string;
  language: string;
  answerConfirm: (confirmed: boolean) => void;
  isSignedOut: () => boolean;
  afterSignIn: () => Promise<unknown>;
}) {
  const [authState, setAuthState] = useState<
      "checking" | "ready" | "required" | "misconfigured" | "unavailable"
    >("checking"),
    [authEnabled, setAuthEnabled] = useState(false),
    [authPassword, setAuthPassword] = useState(""),
    [authError, setAuthError] = useState(""),
    [authNotice, setAuthNotice] = useState(""),
    [passkeySupported, setPasskeySupported] = useState(false),
    [passkeyBusy, setPasskeyBusy] = useState(false);
  const authStateRef = useRef("checking");
  authStateRef.current = authState;
  const authCheckVersion = useRef(0);
  // The session lasts a limited time. When the server starts refusing data requests the app
  // returns to the sign-in screen and says why; nothing local is removed, so changes that were
  // not sent yet go out after signing in again.
  const sessionEndCheck = useRef(false);
  const sessionEndedHere = useRef(false);
  const sessionEndHandler = useRef(() => {});
  sessionEndHandler.current = () => {
    if (authStateRef.current !== "ready" || isSignedOut() || sessionEndCheck.current) return;
    sessionEndCheck.current = true;
    // One refused request is not proof: it may be an answer to a request sent before a fresh
    // sign-in. The server is asked directly, and only its "not signed in" ends the session here.
    fetchClientAuthStatus().then((state) => {
      if (state.authenticated || authStateRef.current !== "ready" || isSignedOut()) return;
      // Leaving a field commits what was typed in it; the shell is about to be taken off the screen.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      answerConfirm(false);
      setAuthPassword("");
      setAuthError("");
      setAuthNotice(tr("sessionEnded"));
      sessionEndedHere.current = true;
      setAuthState("required");
    }).catch(() => undefined).finally(() => { sessionEndCheck.current = false; });
  };
  // A sign-in error shown in one language is not kept after the language changes.
  useEffect(() => setAuthError(""), [language]);
  const offlineMessage = useRef("");
  offlineMessage.current = tr("offlineStartTitle");
  useEffect(() => {
    const original = window.fetch;
    const watched = failWhileOffline(
      watchSession(original.bind(window), window.location.origin, () => sessionEndHandler.current()),
      window.location.origin, () => authStateRef.current === "unavailable", () => offlineMessage.current);
    window.fetch = watched as typeof window.fetch;
    return () => { if (window.fetch === watched) window.fetch = original; };
  }, []);
  useEffect(() => { if (authState === "ready") { setAuthNotice(""); sessionEndedHere.current = false; } }, [authState]);
  // `quiet`: a check in the background keeps the screen as it is until there is an answer.
  // Returns the state this check found, or nothing when a newer check replaced it.
  async function checkAccess(quiet = false) {
    const version = ++authCheckVersion.current;
    setAuthError("");
    if (!quiet) setAuthState("checking");
    try {
      const state = await fetchClientAuthStatus();
      if (version !== authCheckVersion.current) return;
      setAuthEnabled(state.enabled);
      if (state.enabled && !state.configured) {
        setAuthError(tr("authMisconfigured"));
        setAuthState("misconfigured");
        return "misconfigured";
      }
      const next = state.authenticated ? "ready" : "required";
      // From the offline view straight to the sign-in screen (the session ended meanwhile): leaving
      // a field commits what was typed in it before the app is taken off the screen.
      if (next === "required" && authStateRef.current === "unavailable" && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setAuthState(next);
      return next;
    } catch {
      if (version !== authCheckVersion.current) return;
      setAuthState("unavailable");
      return "unavailable";
    }
  }
  useEffect(() => {
    try { setPasskeySupported(browserSupportsWebAuthn()); } catch { setPasskeySupported(false); }
    void checkAccess();
    return () => { authCheckVersion.current += 1; };
  // The first access check runs once; retries are initiated by the user.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Access could not be checked (no connection when the page loaded). It is checked again as soon
  // as the connection or the window comes back, and every 15 seconds meanwhile, so the screen does
  // not stay there after the connection has returned.
  useEffect(() => {
    if (authState !== "unavailable") return;
    let checking = false;
    const retry = () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      void checkAccess(true).finally(() => { checking = false; });
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    const timer = window.setInterval(retry, 15_000);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
      window.clearInterval(timer);
    };
  // checkAccess only reads refs and setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (!window.isSecureContext) {
      setAuthError(tr("authNeedsHttps"));
      return;
    }
    setAuthError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: authPassword }),
      });
      if (!response.ok) {
        // The server's messages are English; the common answers are shown in the interface language.
        const body = await response.json().catch(() => ({}));
        setAuthError(response.status === 401 ? tr("signInInvalidPassword")
          : response.status === 429 ? tr("signInTooManyAttempts")
            : response.status === 503 ? tr("authMisconfigured")
              : localizeServerError(body.error, tr) || tr("signInFailed"));
        return;
      }
      setAuthPassword("");
      setAuthState("ready");
      await afterSignIn();
    } catch {
      setAuthError(tr("authUnreachable"));
    }
  }

  async function signInWithPasskey() {
    setPasskeyBusy(true);
    setAuthError("");
    try {
      const optionsResponse = await fetch("/api/auth/passkeys/login/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const options = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(localizeServerError(options.error, tr) || tr("passkeySignInUnavailable"));
      const credential = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch("/api/auth/passkeys/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: options.challenge, response: credential }),
      });
      const result = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(localizeServerError(result.error, tr) || tr("passkeySignInFailed"));
      setAuthState("ready");
      await afterSignIn();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : tr("passkeySignInFailed"));
    } finally {
      setPasskeyBusy(false);
    }
  }

  return {
    authState,
    setAuthState,
    authStateRef,
    authEnabled,
    authPassword,
    setAuthPassword,
    authError,
    authNotice,
    sessionEndedHere,
    checkAccess,
    login,
    signInWithPasskey,
    passkeySupported,
    passkeyBusy,
    setPasskeyBusy,
  };
}
