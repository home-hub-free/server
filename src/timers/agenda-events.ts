/**
 * In-process "the agenda changed" signal (LOCAL_AGENDA). The timers repo/scheduler/routes call
 * `notifyAgendaChanged()` after any create/update/cancel/fire; the WebSocket layer subscribes once
 * at boot (agenda-routes.ts) and re-emits it to the dashboard as `agenda-update`. Kept as a tiny
 * listener registry so the scheduler and repo stay import-free of Socket.IO (unit tests need neither).
 */
export type AgendaChange = { reason: "create" | "update" | "cancel" | "fire"; id?: string };

const listeners = new Set<(c: AgendaChange) => void>();

export function onAgendaChanged(fn: (c: AgendaChange) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyAgendaChanged(change: AgendaChange): void {
  for (const fn of listeners) {
    try {
      fn(change);
    } catch {
      // a failing subscriber must never break the mutation that fired it
    }
  }
}
