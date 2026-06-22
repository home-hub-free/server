/**
 * Evap-cooler closed-loop controller — Stage 4c (see docs/DATA_CONTRACTS.md).
 *
 * The hysteresis that decides the cooler's fan + water-pump relays, extracted as a
 * PURE function over a plain channel snapshot (no Node / DB / socket imports) so it
 * runs — and is golden-tested — off the live box, like the evaluator. This is the
 * faithful port of the legacy `applyEvapCoolerEffects` hysteresis; the live caller
 * (`coolerControl` in node.handler) just reads the cooler's channels into this
 * shape and applies the returned updates.
 *
 * Hub-local by design: cooling keeps working with the brain/ingestion down.
 */

/** A cooler's decision inputs — its two sensor temps, the target setting, and the
 * current relay states. All channels of the `evap-cooler` node, flattened. */
export interface CoolerState {
  roomTemp: number; // room-temp sensor channel (°C)
  unitTemp: number; // unit-temp sensor channel (°C) — the cooler's intake/outside temp
  target: number; // target setting channel (°C)
  fan: boolean; // current fan actuator state
  water: boolean; // current water actuator state
}

/** The relay changes to apply — only the channels that differ from `state`. */
export interface CoolerUpdates {
  fan?: boolean;
  water?: boolean;
}

/**
 * Compute the fan/water updates for a cooler from its current channel snapshot.
 * Returns only the relays that should change (so an empty object means "leave it").
 *
 * Hysteresis (a ±1 °C band around `target` avoids relay chatter):
 *  - **fan**: once running, hold until the room drops to `target − 1`; once off,
 *    don't start until the room reaches `target + 1`.
 *  - **water**: needs the room warm AND the intake warm enough to actually cool —
 *    running while `room ≥ target−1 && unit ≥ target`, starting at
 *    `room ≥ target && unit ≥ target`.
 */
export function computeCoolerUpdates(state: CoolerState): CoolerUpdates {
  const fanState = state.fan
    ? state.roomTemp >= state.target - 1
    : state.roomTemp >= state.target + 1;

  const waterState = state.water
    ? state.roomTemp >= state.target - 1 && state.unitTemp >= state.target
    : state.roomTemp >= state.target && state.unitTemp >= state.target;

  const updates: CoolerUpdates = {};
  if (state.water !== waterState) updates.water = waterState;
  if (state.fan !== fanState) updates.fan = fanState;
  return updates;
}
