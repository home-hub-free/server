/**
 * Agenda read model (LOCAL_AGENDA) — expands the `timers` rows (events + reminders, with their
 * recurrence) into dated OCCURRENCES for a window, in the wire shape both consumers already speak:
 *   - the dashboard Agenda view (GET /agenda),
 *   - reflex's calendar read + the morning brief (GET /events — the calendar-service `Event` shape:
 *     `{id,title,start,end,all_day,calendar,day}` with LOCAL-naive ISO starts like "2026-07-03T09:00").
 * Pure over the rows + a clock so it's unit-testable without the DB.
 */
import type { TimerRow } from "../db/timers.repo";
import { describeRecurrence, occurrencesBetween, parseRecurrence } from "./recurrence";

export interface Occurrence {
  /** The row id (cancel/edit target). Recurring rows repeat it across occurrences. */
  id: string;
  kind: "event" | "reminder";
  title: string;
  /** Local-naive ISO ("2026-07-03T09:00"), or a bare date for all-day. */
  start: string;
  end?: string;
  all_day: boolean;
  /** Whose item: the for_person id/name, or "casa" for a house-wide one. */
  calendar: string;
  for_person: string | null;
  zone: string | null;
  recurrence: string | null;
  recurrence_label: string;
  remind_min: number | null;
  message: string | null;
  notes: string | null;
  status: TimerRow["status"];
  /** Relative local-day label ("hoy"/"mañana"/"pasado mañana"/weekday ≤ 6 days out), display only. */
  day: string;
  /** True once this occurrence's start is in the past (for the dashboard's dimming). */
  past: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local-naive ISO minute ("YYYY-MM-DDTHH:MM") — the calendar-service wire convention. */
export function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAY = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** "hoy"/"mañana"/"pasado mañana"/weekday for 3–6 days out; "" otherwise (mirrors calendar-service). */
export function relativeDay(start: Date, now: Date): string {
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(start) - midnight(now)) / 86_400_000);
  if (days === 0) return "hoy";
  if (days === 1) return "mañana";
  if (days === 2) return "pasado mañana";
  if (days >= 3 && days <= 6) return WEEKDAY[start.getDay()];
  return "";
}

/** Parse "YYYY-MM-DD" as LOCAL midnight (Date.parse would read it as UTC). */
export function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse a local-naive ISO minute/second ("YYYY-MM-DDTHH:MM[:SS]") or a full ISO (with zone) instant. */
export function parseWhen(s: string): Date | null {
  const t = s.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (local) {
    const d = new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6] ?? 0));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const date = parseLocalDate(t);
  if (date) return date;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Does this row belong to `owner` (id or display name, case-insensitive)? House-wide rows (no
 *  for_person) belong to everyone. */
export function rowMatchesOwner(row: TimerRow, owner: string | null | undefined, aliases: string[] = []): boolean {
  if (!owner) return true;
  if (!row.for_person) return true;
  const want = new Set([owner, ...aliases].map((s) => s.trim().toLowerCase()).filter(Boolean));
  return want.has(row.for_person.trim().toLowerCase());
}

/** Expand every agenda row into its occurrences within [from, to] (local instants, inclusive). */
export function expandAgenda(rows: TimerRow[], from: Date, to: Date, now = new Date()): Occurrence[] {
  const out: Occurrence[] = [];
  for (const row of rows) {
    if (row.kind !== "event" && row.kind !== "reminder") continue;
    if (!row.fire_at) continue;
    const anchorMs = Date.parse(row.fire_at);
    if (Number.isNaN(anchorMs)) continue;
    const anchor = new Date(anchorMs);
    const rule = parseRecurrence(row.recurrence) ?? null;
    const durationMs = row.end_at ? Math.max(0, Date.parse(row.end_at) - anchorMs) : 0;
    const allDay = row.all_day === 1;
    for (const start of occurrencesBetween(anchor, rule, from, to)) {
      const end = row.end_at ? new Date(start.getTime() + durationMs) : null;
      out.push({
        id: row.id,
        kind: row.kind,
        title: row.title ?? row.message ?? "",
        start: allDay ? fmtLocalDate(start) : fmtLocal(start),
        ...(end && !allDay ? { end: fmtLocal(end) } : {}),
        all_day: allDay,
        calendar: row.for_person ?? "casa",
        for_person: row.for_person,
        zone: row.zone,
        recurrence: row.recurrence,
        recurrence_label: describeRecurrence(rule),
        remind_min: row.kind === "event" ? row.remind_min : 0,
        message: row.message,
        notes: row.notes,
        status: row.status,
        day: relativeDay(start, now),
        past: start.getTime() < now.getTime(),
      });
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return out;
}

/** The scheduler's spoken line for an event with no explicit message. */
export function eventAnnouncement(row: TimerRow, now: Date): string {
  const title = (row.title ?? row.message ?? "").trim() || "tu evento";
  const start = row.fire_at ? new Date(Date.parse(row.fire_at)) : now;
  if (row.all_day === 1) {
    const rel = relativeDay(start, now);
    return rel === "hoy" || !rel ? `Recordatorio para hoy: ${title}.` : `Recordatorio para ${rel}: ${title}.`;
  }
  const minutes = Math.round((start.getTime() - now.getTime()) / 60_000);
  const hhmm = `${start.getHours()}:${pad(start.getMinutes())}`;
  if (minutes <= 1) return `Recordatorio: ${title}, ahora.`;
  if (minutes < 60) return `Recordatorio: ${title} en ${minutes} minutos.`;
  const rel = relativeDay(start, now);
  if (rel && rel !== "hoy") return `Recordatorio: ${title} ${rel} a las ${hhmm}.`;
  return `Recordatorio: ${title} a las ${hhmm}.`;
}
