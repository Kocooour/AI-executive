// Announces a completed sign-in in this tab (no page reload) so the target client runtime can
// re-verify its auth generation. Content-free: carries no identity, token or payload. Safe when
// the target UI is off: nothing listens to the window event and the legacy session channel
// listener reacts only to "signed-out", so no request is made.
export const TARGET_SIGNED_IN_EVENT = "lumi:auth-signed-in";
export const TARGET_SIGNED_IN_MESSAGE = "signed-in";

export function announceSignedIn(env: {
  window?: { dispatchEvent?(event: Event): boolean } | null;
  broadcastChannelFactory?: ((name: string) => { postMessage(data: unknown): void; close(): void }) | null;
} = {}): void {
  // A BroadcastChannel message reaches every other channel object of this origin, including the
  // runtime's own channel in this tab, so it covers this tab and other tabs with one refresh each.
  // Without BroadcastChannel, fall back to a same-tab window event.
  try {
    const factory = env.broadcastChannelFactory === undefined
      ? (typeof BroadcastChannel !== "undefined" ? (name: string) => new BroadcastChannel(name) : null)
      : env.broadcastChannelFactory;
    const channel = factory ? factory("ai-executive-session") : null;
    if (channel) { channel.postMessage(TARGET_SIGNED_IN_MESSAGE); channel.close(); return; }
  } catch { /* unsupported: fall back below */ }
  const win = env.window === undefined ? (typeof window !== "undefined" ? window : null) : env.window;
  try {
    if (win?.dispatchEvent && typeof Event !== "undefined") win.dispatchEvent(new Event(TARGET_SIGNED_IN_EVENT));
  } catch { /* unsupported */ }
}
