export default function OfflinePage() {
  return (
    <main className="offlinePage">
      <div>
        <span className="offlineIcon" aria-hidden="true" />
        <h1>You&apos;re offline</h1>
        <p>
          Lumi will reconnect and synchronize when this device is back
          online.
        </p>
        <a href="/">Try again</a>
      </div>
    </main>
  );
}
