import { IngestionSource } from "../clients/ingestion";

/**
 * Manual-lock policy for actuation writes. The agent reaches the hub through the same
 * `/device-update` door as a dashboard user — `manualTrigger`, which bypasses all conditions —
 * so this pure decision is the only thing standing between an autonomous inference and a user's
 * manual override. Kept import-light (type-only deps) so it unit-tests in isolation.
 */

export type WritePolicyInput = {
  /** Resolved provenance of the HTTP call (dashboard | llm | voice). */
  source: IngestionSource;
  /** Gateway hint: is the agent relaying an explicit user command ("user") or acting on its
   *  own initiative ("agent")? **Absent ⇒ treated as "agent"** — the safe default, so an
   *  un-updated gateway can never stomp a manual lock. Ignored for `dashboard` (always human). */
  onBehalfOf?: "user" | "agent";
  /** Whether the target currently holds the `manual` lock. */
  nodeManual: boolean;
  /** Role of the addressed channel, if any. A `setting`-role channel (e.g. the cooler's
   *  `target`) is a setpoint, not an actuator override: never lock-gated, never latches. */
  channelRole?: string;
};

export type WritePolicy = {
  /** Drop the write: the target is manually locked and no human is behind this write. */
  skip: boolean;
  /** Take the `manual` lock — a human just grabbed the wheel (by tap or by spoken command). */
  latch: boolean;
};

/**
 * One question decides both flags: *is there a human behind THIS write?* A dashboard tap always
 * is; an agent (llm/voice) write only when the gateway flags it as relaying a user command.
 *
 * - **Human-behind** writes bypass the lock and latch it — the user wins, exactly like a tap.
 * - **Agent-initiative** writes respect the lock (skip if held) and never latch — they behave
 *   like any other automation (`autoTrigger`/effects already drop manually-locked targets).
 *
 * The hub previously routed every agent write through `manualTrigger`, which bypasses all
 * conditions — so autonomous inferences stomped manual overrides. This restores that boundary
 * without blocking a direct spoken command (which IS the user grabbing the wheel by voice).
 */
export function decideWritePolicy(input: WritePolicyInput): WritePolicy {
  const humanBehind = input.source === "dashboard" || input.onBehalfOf === "user";
  const isSetting = input.channelRole === "setting";
  return {
    skip: !humanBehind && input.nodeManual && !isSetting,
    latch: humanBehind && !isSetting,
  };
}
