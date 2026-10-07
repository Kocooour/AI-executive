export async function register() {
  // Keep the import inside this branch: Next.js also compiles this file for the Edge runtime,
  // where the schedulers' Node-only dependencies (web-push, node:sqlite) cannot be resolved.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSchedulers } = await import("./lib/schedulers");
    await startSchedulers();
  }
}
