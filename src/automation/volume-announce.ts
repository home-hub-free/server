import { announceToZone } from "../clients/satellite-announce";
import { spanishNumber } from "../utils/spanish-number";

/**
 * Volume-announce debounce — SATELLITE_VOLUME_FEEDBACK
 * (docs/plans/SATELLITE_VOLUME_FEEDBACK.md).
 *
 * A slider drag emits a burst of writes into Node.notify(); only the FINAL settled
 * volume should produce a spoken confirmation. Debounce is TRAILING, per node id,
 * 1200 ms: every call restarts that node's timer, so only the last (zone, volume)
 * pair within the window survives to fire. The timer is unref()'d — it must never
 * keep the process alive on its own.
 *
 * Zone is required: a satellite with no zone set is skipped outright (no timer is
 * even armed) — the delivery flow can only resolve zone → IP, so a zoneless call
 * would just warn and drop downstream anyway; this avoids the pointless wait.
 *
 * The announce sink is injectable — matches src/timers/scheduler.ts's `Announce` DI
 * pattern — so tests assert the debounced call without a real HTTP POST; the default
 * wires to the real satellite-announce client.
 */
export type AnnounceSink = (text: string, zone: string) => void;

const DEBOUNCE_MS = 1200;

/** node id -> pending trailing-debounce timer. */
const pending = new Map<string, NodeJS.Timeout>();

/** Debounce+schedule a volume-confirmation announce for `nodeId`. Restarts the
 * per-node timer on every call; only the last (zone, volume) pair within the
 * trailing window is spoken. `sink` defaults to the real satellite-announce client
 * and is overridden in tests. */
export function scheduleVolumeAnnounce(
  nodeId: string,
  zone: string,
  volume: number,
  sink: AnnounceSink = announceToZone,
): void {
  if (!zone) return; // no zone -> delivery can't resolve an IP; don't even wait

  const existing = pending.get(nodeId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pending.delete(nodeId);
    sink(`Volumen al ${spanishNumber(volume)} por ciento.`, zone);
  }, DEBOUNCE_MS);
  timer.unref?.();
  pending.set(nodeId, timer);
}

/** Test hook: clear every pending debounce timer between specs. */
export function _reset(): void {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}
