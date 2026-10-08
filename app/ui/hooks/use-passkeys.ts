"use client";
import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type { ConfirmRequest, PasskeySummary } from "../types";

// Passkeys in Settings: the list, adding one (confirmed with the password) and removing one.
// Moved verbatim from use-lumi-app.tsx. Signing in with a passkey is part of the sign-in flow
// (use-sign-in.ts), which owns `passkeySupported` and `passkeyBusy`; adding a passkey shares the
// busy flag, so its setter is passed in.
export function usePasskeys({ view, authState, tr, askConfirm, setPasskeyBusy }: {
  view: string;
  authState: string;
  tr: (key: string) => string;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
  setPasskeyBusy: (busy: boolean) => void;
}) {
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]),
    [passkeyLabel, setPasskeyLabel] = useState(""),
    [passkeyPassword, setPasskeyPassword] = useState(""),
    [passkeyStatus, setPasskeyStatus] = useState("");

  useEffect(() => {
    if (view !== "Settings" || authState !== "ready") return;
    loadPasskeys().catch(() => setPasskeyStatus(tr("passkeysLoadFailed")));
  }, [view, authState]);

  async function loadPasskeys() {
    const response = await fetch("/api/auth/passkeys", { cache: "no-store" });
    if (!response.ok) throw new Error(tr("passkeysLoadFailed"));
    const body = await response.json();
    setPasskeys(body.passkeys || []);
  }

  async function registerPasskey() {
    setPasskeyBusy(true);
    setPasskeyStatus("");
    try {
      const optionsResponse = await fetch("/api/auth/passkeys/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: passkeyPassword }),
      });
      const options = await optionsResponse.json();
      if (!optionsResponse.ok) throw new Error(options.error || tr("passkeyRegisterUnavailable"));
      const credential = await startRegistration({ optionsJSON: options });
      const verifyResponse = await fetch("/api/auth/passkeys/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challenge: options.challenge,
          response: credential,
          label: passkeyLabel.trim() || tr("passkeyPlaceholder"),
        }),
      });
      const result = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(result.error || tr("passkeyRegisterFailed"));
      await loadPasskeys();
      setPasskeyPassword("");
      setPasskeyStatus(tr("passkeyAdded"));
    } catch (error) {
      setPasskeyStatus(error instanceof Error ? error.message : tr("passkeyRegisterFailed"));
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function removePasskey(id: string) {
    if (!(await askConfirm({ title: tr("passkeyRemoveTitle"), message: tr("passkeyRemoveConfirm"), confirmLabel: tr("remove"), danger: true }))) return;
    const response = await fetch("/api/auth/passkeys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setPasskeyStatus(body.error || tr("passkeyRemoveFailed"));
      return;
    }
    await loadPasskeys();
    setPasskeyStatus(tr("passkeyRemoved"));
  }

  return {
    passkeys,
    passkeyLabel,
    setPasskeyLabel,
    passkeyPassword,
    setPasskeyPassword,
    passkeyStatus,
    registerPasskey,
    removePasskey,
  };
}
