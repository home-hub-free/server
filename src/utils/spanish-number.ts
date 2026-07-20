/**
 * Spanish number-to-words — 0–100 integers only, deterministic (no LLM).
 *
 * Built for SATELLITE_VOLUME_FEEDBACK (docs/plans/SATELLITE_VOLUME_FEEDBACK.md): the
 * spoken confirmation template is `Volumen al <n> por ciento.`, and Fish Speech reads
 * digit strings unreliably ("45" doesn't reliably come out as "cuarenta y cinco"). A
 * fixed template needs a fixed, testable mapping — not reflex's LLM verbalizer, which
 * is the wrong layer for a string that never varies.
 *
 * Spanish number words below 100 are irregular enough to need a real table:
 *  - 16–19 contract to "dieci-" + unit ("dieciséis"), not "diez y seis";
 *  - 21–29 contract to "veinti-" + unit ("veintidós"), not "veinte y dos";
 *  - 31–99 (non-multiples of ten) instead use the UNCONTRACTED "tens y unit" form
 *    ("treinta y uno", "cuarenta y cinco") — the contraction is unique to the twenties;
 *  - 100 is "cien", not "ciento" (the latter only prefixes a following number, e.g.
 *    "ciento uno" — out of scope, the volume channel's range tops out at 100 exactly).
 */

const UNITS_0_19 = [
  "cero",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciséis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
];

const TWENTIES: Record<number, string> = {
  20: "veinte",
  21: "veintiuno",
  22: "veintidós",
  23: "veintitrés",
  24: "veinticuatro",
  25: "veinticinco",
  26: "veintiséis",
  27: "veintisiete",
  28: "veintiocho",
  29: "veintinueve",
};

const TENS: Record<number, string> = {
  30: "treinta",
  40: "cuarenta",
  50: "cincuenta",
  60: "sesenta",
  70: "setenta",
  80: "ochenta",
  90: "noventa",
};

/** Integer 0–100 → Spanish words. Defensively rounds and clamps out-of-domain input
 * (never throws) — the volume channel is already range-clamped by the time this runs,
 * but the helper stays safe standalone since it renders text for a device action. */
export function spanishNumber(n: number): string {
  const value = Math.min(100, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

  if (value === 100) return "cien";
  if (value < 20) return UNITS_0_19[value];
  if (value < 30) return TWENTIES[value];

  const ten = Math.floor(value / 10) * 10;
  const unit = value % 10;
  return unit === 0 ? TENS[ten] : `${TENS[ten]} y ${UNITS_0_19[unit]}`;
}
