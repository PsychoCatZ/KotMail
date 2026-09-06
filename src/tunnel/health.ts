export function readHealth(value: unknown): { processRunning: boolean; healthy: boolean; ready: boolean } {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  // Nested historical/remote status must not turn a dead local runtime green.
  return { processRunning: root.process_running === true, healthy: root.healthy === true, ready: root.ready === true };
}
