(() => {
  "use strict";
  const form = document.getElementById("gmail-complete");
  const status = document.getElementById("status");
  if (!form || !status) return;
  const state = form.querySelector('[name="state"]')?.value || "";
  const code = form.querySelector('[name="code"]')?.value || "";
  // The authorization code is not retained in the address bar or in navigation history.
  window.history.replaceState(null, "", "/api/mail/gmail/callback");
  form.addEventListener("submit", (event) => { event.preventDefault(); void finish(); });
  let running = false;
  async function finish() {
    if (running) return;
    running = true;
    form.hidden = true;
    try {
      const response = await fetch("/api/mail/gmail/callback", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, code }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Connection refused");
      window.location.replace("/?view=Settings&gmail=connected");
    } catch {
      running = false;
      status.textContent = "Připojení se nezdařilo. Vrať se do Lumi a zkus to znovu.";
      form.hidden = false;
    }
  }
  void finish();
})();
