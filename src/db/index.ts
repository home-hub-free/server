import { importLegacyJson } from "./migrate";

export { db } from "./connection";
export { DevicesRepo } from "./devices.repo";
export { SensorsRepo } from "./sensors.repo";
export { EffectsRepo, IEffect } from "./effects.repo";
export { ConfigRepo } from "./config.repo";
export { TimersRepo, elapsedSeconds } from "./timers.repo";
export type { TimerRow, TimerKind, TimerStatus, CreateTimerInput } from "./timers.repo";

/**
 * Initialize the hub's SQLite store. The connection + schema are applied lazily on
 * first import of any repo; this runs the one-time legacy-JSON migration. Call it
 * before the HTTP server starts accepting device declarations.
 */
export function initDb(): void {
  importLegacyJson();
}
