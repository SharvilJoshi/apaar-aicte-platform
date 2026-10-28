// APAAR (Academic Permanent Account Number) — 12 digit national academic identity.
// Port of lib/apaar.rb; see that file for the full format description:
//   [entity][batch][YYYY admission year][2-digit institution slot][3-digit sequence][Luhn check digit]

const FORMAT_RE = /^[12]\d{11}$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2035;

// Luhn (mod-10) check digit for the given 11-digit body.
export function checkDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = parseInt(body[i], 10) || 0;
    if (i % 2 === 1) d *= 2;
    if (d > 9) d -= 9;
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function generate(institutionSlot: number, year: number, sequence: number): string {
  const slot = Math.min(Math.max(institutionSlot, 0), 99);
  const body = "12" + String(year).padStart(4, "0") + String(slot).padStart(2, "0") +
    String(sequence % 1000).padStart(3, "0");
  return body + checkDigit(body);
}

// Strips display formatting ("12 2021 20201 4" -> "122021202014").
export function normalize(id: unknown): string {
  return (id == null ? "" : String(id)).replace(/[\s-]/g, "");
}

export interface ApaarCheck {
  valid: boolean;
  errors: string[];
}

export function validate(id: unknown, admissionYear?: unknown): ApaarCheck {
  const errors: string[] = [];
  const raw = normalize(id);
  if (raw === "") return { valid: false, errors: ["APAAR ID is missing"] };
  if (!FORMAT_RE.test(raw)) {
    return { valid: false, errors: ["APAAR ID must be a 12-digit number starting with 1 or 2"] };
  }
  if (checkDigit(raw.slice(0, 11)) !== Number(raw[11])) {
    errors.push("APAAR ID has an invalid check digit (failed Luhn verification)");
  }
  const year = parseInt(raw.slice(2, 6), 10);
  if (year < MIN_YEAR || year > MAX_YEAR) errors.push(`APAAR ID embeds an implausible enrolment year (${year})`);
  if (admissionYear != null && admissionYear !== false && year !== toInt(admissionYear)) {
    errors.push(`APAAR enrolment year (${year}) does not match admission year (${admissionYear})`);
  }
  return { valid: errors.length === 0, errors };
}

export function masked(id: unknown): string {
  const s = id == null ? "" : String(id);
  return s.length === 12 ? `${s.slice(0, 4)}••••${s.slice(10, 12)}` : s;
}

export function pretty(id: unknown): string {
  const s = id == null ? "" : String(id);
  return s.length === 12 ? `${s.slice(0, 2)} ${s.slice(2, 6)} ${s.slice(6, 11)} ${s.slice(11)}` : s;
}

// Ruby-style #to_i: leading integer of the string form, 0 when there is none.
export function toInt(v: unknown): number {
  if (typeof v === "number") return Math.trunc(v);
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}
