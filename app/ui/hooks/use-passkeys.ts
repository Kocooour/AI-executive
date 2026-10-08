"use client";
import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type { ConfirmRequest, PasskeySummary } from "../types";

// Passkeys in Settings: the list, adding one (confirmed with the password) and removing one.
// Moved verbatim from use-lumi-app.tsx. Signing in with a passkey is part of the sign-in flow and
// stays there; it shares `passkeyBusy` and `passkeySupported`, so their setters are returned too.
export function usePasskeys({ view, authState, tr, askConfirm }: {
  view: string;
  authState: string;
  tr: (key: string) => string;
  askConfirm: (request: ConfirmRequest) => Promise<boolean>;
}) {
  const [passkeySupported, setPasskeySupported] = useState(false),
    [passkeyBusy, setPasskeyBusy] = useState(false),
    [passkeys, setPasskeys] = useState<PasskeySummary[]>([]),
    [passkeyLabel, setPasskeyLabel] = useState("My passkey"),
    [passkeyPassword, setPasskeyPassword] = useState(""),
    [passkeyStatus, setPasskeyStatus] = useState("");

  useEffect(() => {
    if (view !== "Settings" || authState !== "ready") return;
    loadPasskeys().catch(() => setPasskeyStatus("Passkeys could not be loaded."));
  }, [view, authState]);

  async function loadPasskeys() {
    const response = await fetch("/api/auth/passkeys", { cache: "no-store" });
    if (!response.ok) throw new Error("Passkeys could not be loaded.");
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
      if (!optionsResponse.ok) throw new Error(options.error || "Passkey registration is unavailable.");
      const credential = await startRegistration({ optionsJSON: options });
      const verifyResponse = await fetch("/api/auth/passkeys/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challenge: options.challenge,
          response: credential,
          label: passkeyLabel.trim() || "Passkey",
        }),
      });
      const result = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(result.error || "Passkey registration failed.");
      await loadPasskeys();
      setPasskeyPassword("");
      setPasskeyStatus("Passkey added. You can now use Face ID or Touch ID to sign in.");
    } catch (error) {
      setPasskeyStatus(error instanceof Error ? error.message : "Passkey registration failed.");
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
      setPasskeyStatus(body.error || "Passkey could not be removed.");
      return;
    }
    await loadPasskeys();
    setPasskeyStatus("Passkey removed.");
  }

  return {
    passkeys,
    passkeySupported,
    setPasskeySupported,
    passkeyBusy,
    setPasskeyBusy,
    passkeyLabel,
    setPasskeyLabel,
    passkeyPassword,
    setPasskeyPassword,
    passkeyStatus,
    registerPasskey,
    removePasskey,
  };
}
