/**
 * Day-part classification — pure function of the clock, shared by GET /state (the `dayPart` field
 * the agent reads) and speak-gain.ts (the night-boost cap). Pulled out of state-routes.ts so both
 * call sites read the SAME source instead of drifting: state-routes.ts imports speak-gain.ts (for
 * the per-zone gain), so speak-gain.ts importing dayPart back out of state-routes.ts would be a
 * circular import — this tiny shared module is the fix.
 */
export type DayPart = "morning" | "afternoon" | "evening" | "night";

export function dayPart(d: Date): DayPart {
  const h = d.getHours();
  if (h < 6) return "night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}
