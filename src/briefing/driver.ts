/**
 * Morning-brief driver (docs/BRIEFING_ROUTINE.md) — the always-on, presence-anchored trigger.
 * First charter-governed feature: a seeded default (PHILOSOPHY.md §2) that stays answerable to
 * observation via per-user prefs (`prefs.brief`), never a learned pattern the person must earn.
 *
 * Each tick, for every household member with the brief enabled who hasn't been evaluated today:
 *  - inside their morning window + seen in a visible zone as a CONFIDENT household identity →
 *    assemble (calendar today + weather) and announce in that zone — count-only when the room
 *    is shared (§3.4: never read titles to a room with other people in it);
 *  - window closed and never seen → the brief drops to the quiet surface (a logged note), never
 *    spoken to an empty house.
 *
 * The trigger is FIRST presence: one evaluation latches the person for the day (persisted in
 * kv_config so a hub restart mid-morning doesn't re-brief), even when the calendar was empty —
 * no re-polling all morning, no retro-brief for events added later. Only an assembly FAILURE
 * (calendar-service unreachable) leaves the person unlatched so the next tick retries.
 *
 * Governance note (§3.6 divergence): the proactive-speech governor lives in the llm-gateway and
 * has no budget API the hub can call — the timer scheduler's announcements bypass it for the
 * same reason. The brief's window + once-per-day latch + calendar self-gate are its governance;
 * folding hub-side announcements into the gateway budget is a (deferred) cross-service seam.
 *
 * Mirrors timers/scheduler.ts: pure decision helpers (clock/rooms/prefs injected) + an interval.
 */
import { liveRooms } from "../ambient/live-rooms";
import type { RoomDigest } from "../ambient/room-digest";
import { usersRepo, PublicUser } from "../db/users.repo";
import { ConfigRepo } from "../db/config.repo";
import { log, EVENT_TYPES } from "../logger";
import type { Announce } from "../timers/scheduler";
import { assembleBrief, buildBriefText, defaultFetchers, BriefFetchers } from "./assemble";

/** Per-user brief prefs, stored under `prefs.brief` on the hub `users` row — tuning never needs
 *  a deploy (§3.5). All optional; the shipped default is ON with the 05:00–11:00 window. */
export interface BriefPrefs {
  enabled?: boolean;
  /** "HH:MM" overrides for the morning window. */
  windowStart?: string;
  windowEnd?: string;
  /** Preferred depth when the room is private; a shared room always degrades to "count". */
  depth?: "full" | "count";
}

// Same bar the gateway's prompt lane applies to a vision identity (AGENT_IDENTITY_CONF_MIN).
const IDENTITY_CONFIDENCE_MIN = Number(process.env.BRIEF_IDENTITY_CONF_MIN ?? 0.6);
const WINDOW_START = process.env.BRIEF_WINDOW_START ?? "05:00";
const WINDOW_END = process.env.BRIEF_WINDOW_END ?? "11:00";

// One kv_config key holding { [userId]: "YYYY-MM-DD" } — the per-person daily latch (§3.6).
const LATCH_KEY = "briefingLatch";
const configRepo = new ConfigRepo();

export interface LatchStore {
  get(userId: string): string | undefined;
  set(userId: string, date: string): void;
}

const defaultLatch: LatchStore = {
  get(userId) {
    const all = configRepo.get(LATCH_KEY) ?? {};
    return all[userId];
  },
  set(userId, date) {
    const all = configRepo.get(LATCH_KEY) ?? {};
    all[userId] = date;
    configRepo.set(LATCH_KEY, all);
  },
};

/** Local calendar-day key ("2026-07-02") — latch granularity and the calendar `from` param. */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "HH:MM" → minutes-of-day, or null when malformed. */
function parseHM(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function windowFor(prefs: BriefPrefs): { start: number; end: number } {
  return {
    start: parseHM(prefs.windowStart) ?? parseHM(WINDOW_START) ?? 5 * 60,
    end: parseHM(prefs.windowEnd) ?? parseHM(WINDOW_END) ?? 11 * 60,
  };
}

/** Where a user is right now per the fused world-model — but unlike the scheduler's personZone,
 *  gated on a CONFIDENT household identity (§3.6: an unknown/low-confidence face at breakfast
 *  gets nothing). `shared` marks a room with anyone else in it (the §3.4 privacy degrade). */
export function confidentZone(
  rooms: Record<string, RoomDigest>,
  user: Pick<PublicUser, "id" | "displayName">,
): { zone: string; shared: boolean } | undefined {
  const id = user.id.toLowerCase();
  const name = user.displayName.trim().toLowerCase();
  for (const r of Object.values(rooms)) {
    for (const p of r.people ?? []) {
      const match =
        (p.id && p.id.toLowerCase() === id) ||
        (p.name && p.name.trim().toLowerCase() === name);
      if (!match) continue;
      if (p.cls !== "household" || (p.confidence ?? 0) < IDENTITY_CONFIDENCE_MIN) continue;
      const count = r.count ?? r.people?.length ?? 1;
      return { zone: r.zone, shared: count > 1 };
    }
  }
  return undefined;
}

export type BriefDecision =
  | { action: "deliver"; zone: string; shared: boolean }
  | { action: "quiet" } // window closed, never seen → quiet surface
  | { action: "wait" } // window not open yet, or open but the person isn't visible yet
  | { action: "skip"; reason: string };

/** Pure per-user decision for one tick. The latch value is today's evaluation marker. */
export function decideBrief(
  user: PublicUser,
  rooms: Record<string, RoomDigest>,
  now: Date,
  latchedDate: string | undefined,
): BriefDecision {
  const prefs = (user.prefs?.brief ?? {}) as BriefPrefs;
  if (prefs.enabled === false) return { action: "skip", reason: "disabled" };
  if (latchedDate === localDateKey(now)) return { action: "skip", reason: "latched" };
  const { start, end } = windowFor(prefs);
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < start) return { action: "wait" };
  if (minutes > end) return { action: "quiet" };
  const seen = confidentZone(rooms, user);
  return seen ? { action: "deliver", zone: seen.zone, shared: seen.shared } : { action: "wait" };
}

export interface BriefTickDeps {
  users(): PublicUser[];
  rooms(): Record<string, RoomDigest>;
  announce: Announce;
  /** The undeliverable-brief fallback (§3.4): a quiet, never-spoken surface. */
  quietNote(user: PublicUser, text: string): void;
  fetchers: BriefFetchers;
  latch: LatchStore;
}

/** One scheduler pass over every household member. Exposed (with deps injected) for tests. */
export async function runBriefTick(now: Date, deps: BriefTickDeps): Promise<void> {
  const today = localDateKey(now);
  let rooms: Record<string, RoomDigest> | undefined; // lazy — only resolved when someone needs it
  for (const user of deps.users()) {
    const decision = decideBrief(user, (rooms ??= deps.rooms()), now, deps.latch.get(user.id));
    if (decision.action === "skip" || decision.action === "wait") continue;
    let facts;
    try {
      facts = await assembleBrief(user.id, today, deps.fetchers);
    } catch (err: any) {
      // calendar-service unreachable — leave unlatched; the next tick retries.
      log(EVENT_TYPES.error, [`[brief] assembly failed for ${user.id}:`, err?.message ?? String(err)]);
      continue;
    }
    // null = no personal calendar linked; [] = nothing today (the self-gate). Both latch silently.
    if (facts && facts.events.length > 0) {
      const prefs = (user.prefs?.brief ?? {}) as BriefPrefs;
      if (decision.action === "deliver") {
        const depth = decision.shared ? "count" : prefs.depth === "count" ? "count" : "full";
        try {
          deps.announce(buildBriefText(user.displayName, facts, depth), decision.zone);
        } catch {
          // A failing speaker must not wedge the tick; the latch below still applies (a brief
          // that errored at the speaker is not worth re-firing into the same broken sink).
        }
      } else {
        try {
          deps.quietNote(user, buildBriefText(user.displayName, facts, "full"));
        } catch {}
      }
    }
    deps.latch.set(user.id, today);
  }
}

/** Default quiet surface: a logged note, same contract as the scheduler's (never spoken). */
function defaultQuietNote(user: PublicUser, text: string): void {
  log(EVENT_TYPES.info, [`[brief] ${user.id} never seen in a visible zone this morning; kept quiet:`, text]);
}

/** Speak through the hub's zone-aware announce sink — lazily required so tests/CLIs needn't load
 *  Polly/play-sound (same pattern as the timer scheduler's defaultAnnounce). */
function defaultAnnounce(text: string, zone?: string | null): void {
  const { assistant } = require("../v-assistant/v-assistant.class");
  assistant.say(text, true, zone ?? undefined).catch(() => {});
}

let handle: NodeJS.Timeout | null = null;
let ticking = false;

/** Start the periodic tick (presence within a 6-hour window doesn't need sub-minute latency). */
export function initBriefing(intervalMs = 60_000): void {
  if (handle) return;
  const deps: BriefTickDeps = {
    users: () => usersRepo.list(),
    rooms: () => liveRooms(),
    announce: defaultAnnounce,
    quietNote: defaultQuietNote,
    fetchers: defaultFetchers,
    latch: defaultLatch,
  };
  handle = setInterval(() => {
    if (ticking) return; // a slow calendar call must not stack ticks
    ticking = true;
    runBriefTick(new Date(), deps)
      .catch(() => {}) // never let a tick error kill the interval
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  handle.unref?.();
}

export function stopBriefing(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
