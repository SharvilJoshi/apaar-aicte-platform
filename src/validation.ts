// Automated validation + anomaly detection over student records.
// Port of lib/validation.rb — rule codes and messages are unchanged:
//   DUP-001, DUP-002, APAAR-001, APAAR-002, INTAKE-001/002/003,
//   DATA-001, DATA-002, ENR-001, CONSENT-001
import * as Apaar from "./apaar.js";

export type Rec = Record<string, any>;

export interface Finding {
  code: string;
  severity: "error" | "warning";
  message: string;
  field: string | null;
  apaar_id: string | null;
  institution_id: string | null;
  programme_id: string | null;
}

export interface StudentIndex {
  byApaar: Map<string, Rec[]>;
  byEnrol: Map<string, Rec>;
}

const CATEGORIES = ["General", "OBC", "SC", "ST", "EWS"];
const GENDERS = ["M", "F", "Other"];
const SEAT_TYPES = ["Regular", "Supernumerary", "NRI", "OCI", "ForeignNational"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const PHONE_RE = /^\d{10}$/;
const MANDATORY = ["name", "dob", "gender", "category", "programme_id", "enrolment_no"];

// Ruby truthiness: only nil and false are falsy.
export const present = (v: unknown) => v !== null && v !== undefined && v !== false;
export const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const enrolKey = (inst: unknown, no: unknown) => `${str(inst)}\u0000${str(no)}`;

export function programmeIndex(programmes: Rec[] | Map<string, Rec>): Map<string, Rec> {
  if (programmes instanceof Map) return programmes;
  return new Map(programmes.map((p) => [str(p.id), p]));
}

// Hash indexes so a full-repository sweep is O(n) instead of O(n²).
export function buildIndex(students: Rec[]): StudentIndex {
  const byApaar = new Map<string, Rec[]>();
  const byEnrol = new Map<string, Rec>();
  for (const s of students) {
    const k = str(s.apaar_id);
    if (!byApaar.has(k)) byApaar.set(k, []);
    byApaar.get(k)!.push(s);
    const no = str(s.enrolment_no);
    if (no !== "") byEnrol.set(enrolKey(s.institution_id, no), s);
  }
  return { byApaar, byEnrol };
}

// ---- single-record checks (used on upload and on re-validation) -------------
export function checkRecord(
  rec: Rec,
  existing: Rec[] | StudentIndex,
  allProgrammes: Rec[] | Map<string, Rec>,
  institutionId: string | null | undefined,
): Finding[] {
  const out: Finding[] = [];
  const add = (code: string, severity: Finding["severity"], message: string, field: string | null) =>
    out.push(res(code, severity, message, field, rec, institutionId));

  // APAAR structural + checksum
  const v = Apaar.validate(rec.apaar_id, present(rec.admission_year) ? rec.admission_year : undefined);
  for (const msg of v.errors) {
    const code = msg.includes("check digit") || msg.includes("12-digit") ? "APAAR-001" : "APAAR-002";
    add(code, "error", msg, "apaar_id");
  }

  // Missing mandatory fields
  const missing = MANDATORY.filter((f) => str(rec[f]).trim() === "");
  if (missing.length) add("DATA-001", "error", `Missing mandatory field(s): ${missing.join(", ")}`, missing[0]);

  // Category / gender / seat-type vocab
  if (present(rec.category) && !CATEGORIES.includes(rec.category)) {
    add("DATA-002", "error", `Invalid category '${str(rec.category)}' (allowed: ${CATEGORIES.join("/")})`, "category");
  }
  if (present(rec.gender) && !GENDERS.includes(rec.gender)) {
    add("DATA-002", "error", `Invalid gender '${str(rec.gender)}'`, "gender");
  }
  if (present(rec.seat_type) && !SEAT_TYPES.includes(rec.seat_type)) {
    add("DATA-002", "error", `Invalid seat type '${str(rec.seat_type)}'`, "seat_type");
  }

  // Contact fields
  if (present(rec.email) && str(rec.email) !== "" && !EMAIL_RE.test(str(rec.email))) {
    add("DATA-002", "warning", "Invalid email address", "email");
  }
  if (present(rec.phone) && str(rec.phone) !== "" && !PHONE_RE.test(str(rec.phone))) {
    add("DATA-002", "warning", "Mobile number must be 10 digits", "phone");
  }

  // DOB sanity
  const dob = parseDate(rec.dob);
  const adm = parseDate(rec.admission_date);
  if (str(rec.dob) !== "" && dob === null) add("DATA-002", "error", "Date of birth must be YYYY-MM-DD", "dob");
  if (dob !== null && adm !== null && dob > adm) {
    add("DATA-002", "error", "Date of birth is after the admission date", "dob");
  }
  if (dob !== null && adm !== null) {
    const age = Math.floor((adm - dob) / 365.25);
    if (age < 15 || age > 40) add("DATA-002", "warning", `Implausible age at admission (${age} years)`, "dob");
  }

  // OCI / FN consistency. NRI seats are legitimately held by Indian citizens
  // residing abroad, so only OCI/FN conflict with an 'Indian' nationality.
  if ((rec.seat_type === "OCI" || rec.seat_type === "ForeignNational") && str(rec.nationality) === "Indian") {
    add("DATA-002", "error", `Seat type ${rec.seat_type} conflicts with declared nationality 'Indian'`, "nationality");
  }
  if (rec.seat_type === "NRI" && str(rec.nationality) !== "" && str(rec.nationality) !== "Indian") {
    add("DATA-002", "warning", `NRI seat declared with non-Indian nationality '${str(rec.nationality)}'`, "nationality");
  }
  if (rec.seat_type === "OCI" && str(rec.oci_card_no).trim() === "") {
    add("DATA-002", "error", "OCI seat type requires an OCI card number", "oci_card_no");
  }
  if (rec.seat_type === "ForeignNational" && str(rec.passport_no).trim() === "") {
    add("DATA-002", "error", "Foreign National seat type requires a passport number", "passport_no");
  }

  // Programme must exist AND belong to this institution
  const pidx = programmeIndex(allProgrammes);
  const prog = pidx.get(str(rec.programme_id));
  if (present(rec.programme_id) && !prog) {
    add("DATA-001", "error", "Programme does not belong to this institution", "programme_id");
  } else if (prog && str(institutionId) !== "" && str(prog.institution_id) !== str(institutionId)) {
    add("DATA-001", "error",
      `Programme ${prog.id} (${prog.name}) is approved under ${prog.institution_id}, ` +
      `not ${institutionId} — cross-institution admission blocked`, "programme_id");
  }

  // Duplicate APAAR within institution
  const index = Array.isArray(existing) ? buildIndex(existing) : existing;
  const sameApaar = index.byApaar.get(str(rec.apaar_id)) || [];

  // (the enrolment guard keeps id-less dry-runs of an EXISTING record from
  // flagging that same record as its own duplicate)
  const dupIn = sameApaar.find((s) =>
    s.institution_id === institutionId && s.id !== rec.id && str(s.enrolment_no) !== str(rec.enrolment_no));
  if (dupIn) {
    add("DUP-001", "error",
      `Duplicate APAAR ID — already enrolled in this institution as ${dupIn.enrolment_no} (${dupIn.name})`, "apaar_id");
  }

  // Cross-institution duplicate enrolment (the national-level catch)
  for (const s of sameApaar) {
    if (s.institution_id !== institutionId && s.status !== "Withdrawn") {
      add("DUP-002", "error",
        `APAAR ID already enrolled at another institution (${s.institution_name || s.institution_id}, ` +
        `${s.programme_name || s.programme_id})`, "apaar_id");
    }
  }

  // Duplicate enrolment no. within institution
  let dupE = index.byEnrol.get(enrolKey(institutionId, rec.enrolment_no));
  if (dupE && (dupE.id === rec.id || (dupE.apaar_id === rec.apaar_id && dupE.institution_id === institutionId))) {
    dupE = undefined;
  }
  if (dupE && str(rec.enrolment_no) !== "") {
    add("ENR-001", "error", `Duplicate enrolment number (already used by APAAR ${Apaar.masked(dupE.apaar_id)})`,
      "enrolment_no");
  }

  // Consent: data-subject consent must be on file before the record is exposed
  // to authorized verifiers.
  const consent = rec.consent;
  if (!(consent && typeof consent === "object" && consent.granted === true)) {
    add("CONSENT-001", "warning",
      "Student consent for AICTE repository + authorized verification is not recorded", "consent");
  }

  return out;
}

// ---- prospective admission checks ------------------------------------------
// Runs at UPLOAD time so excess admissions are caught BEFORE the commit.
// Existing records edited in place don't re-claim a seat they already hold.
export function checkAdmission(
  rec: Rec,
  students: Rec[],
  programmes: Rec[] | Map<string, Rec>,
  institutionId: string | null | undefined,
): Finding[] {
  if (str(rec.status) === "Withdrawn") return [];
  const prog = programmeIndex(programmes).get(str(rec.programme_id));
  if (!prog) return [];

  let cohortYear = Apaar.toInt(present(rec.admission_year) ? rec.admission_year : str(rec.admission_date).slice(0, 4));
  if (cohortYear < 1900) {
    cohortYear = students.reduce((m, s) => (typeof s.admission_year === "number" && s.admission_year > m ? s.admission_year : m), 0);
  }

  let existing: Rec | undefined;
  if (present(rec.id)) existing = students.find((s) => s.id === rec.id);
  else if (str(rec.apaar_id) !== "") {
    existing = students.find((s) => s.apaar_id === rec.apaar_id && s.institution_id === institutionId);
  }
  const inPlaceEdit = existing && str(existing.programme_id) === str(prog.id);
  const out: Finding[] = [];

  if (inPlaceEdit) {
    if (existing!.seat_type === rec.seat_type) return out;
  } else {
    let others = 0;
    for (const s of students) {
      if (str(s.programme_id) === str(prog.id) && s.id !== rec.id && s.admission_year === cohortYear &&
        s.status !== "Withdrawn") others++;
    }
    const wouldBe = others + 1;
    const approved = Apaar.toInt(prog.approved_intake);
    const snCap = Apaar.toInt(prog.supernumerary_cap);
    if (wouldBe > approved + snCap) {
      out.push(res("INTAKE-001", "error",
        `Admitting this student takes the ${cohortYear} cohort to ${wouldBe}, exceeding approved ` +
        `intake ${approved} + supernumerary ${snCap}`, "programme_id", rec, institutionId, prog.id));
    } else if (wouldBe > approved) {
      out.push(res("INTAKE-002", "warning",
        `The ${cohortYear} cohort would reach ${wouldBe} — above approved intake ${approved} but ` +
        `within supernumerary headroom (${approved + snCap})`, "programme_id", rec, institutionId, prog.id));
    }
  }

  // seat-type quota for the seat being claimed
  const seat = str(rec.seat_type);
  const cap = seat === "Supernumerary" ? Apaar.toInt(prog.supernumerary_cap)
    : seat === "NRI" ? Apaar.toInt(prog.nri_cap)
    : seat === "OCI" || seat === "ForeignNational" ? Apaar.toInt(prog.fn_cap)
    : null;
  if (cap !== null) {
    let used = 0;
    for (const s of students) {
      if (str(s.programme_id) === str(prog.id) && s.seat_type === seat && s.id !== rec.id &&
        s.admission_year === cohortYear) used++;
    }
    if (used + 1 > cap) {
      out.push(res("INTAKE-003", "error",
        `${seat} seats in this programme would reach ${used + 1}, exceeding the permitted cap ${cap}`,
        "seat_type", rec, institutionId, prog.id));
    }
  }
  return out;
}

// ---- aggregate intake checks (programme level) ------------------------------
// Approved intake is sanctioned per academic year: each year's cohort is
// evaluated against it, not the lifetime total of the programme.
export function checkIntake(students: Rec[], programmes: Rec[]): Finding[] {
  const out: Finding[] = [];
  const byProg = groupBy(students, (s) => str(s.programme_id));
  const none = { apaar_id: null };
  for (const p of programmes) {
    const approved = Apaar.toInt(p.approved_intake);
    const snCap = Apaar.toInt(p.supernumerary_cap);
    const nriCap = Apaar.toInt(p.nri_cap);
    const fnCap = Apaar.toInt(p.fn_cap);
    const push = (code: string, sev: Finding["severity"], msg: string) =>
      out.push(res(code, sev, msg, null, none, p.institution_id, p.id));

    for (const [yr, list] of groupBy(byProg.get(str(p.id)) || [], (s) => s.admission_year)) {
      const enrolled = list.length;
      const tag = present(yr) ? ` (${yr} cohort)` : "";
      if (enrolled > approved + snCap) {
        push("INTAKE-001", "error",
          `Enrolment ${enrolled}${tag} exceeds approved intake ${approved} + supernumerary ${snCap} ` +
          `by ${enrolled - approved - snCap} seat(s)`);
      } else if (enrolled > approved) {
        push("INTAKE-002", "warning",
          `Enrolment ${enrolled}${tag} is above approved intake ${approved} but within supernumerary headroom`);
      }
      const sn = list.filter((s) => s.seat_type === "Supernumerary").length;
      if (sn > snCap) push("INTAKE-003", "error", `Supernumerary seats ${sn}${tag} exceed permitted cap ${snCap}`);
      const nri = list.filter((s) => s.seat_type === "NRI").length;
      if (nri > nriCap) push("INTAKE-003", "error", `NRI seats ${nri}${tag} exceed permitted cap ${nriCap}`);
      const fn = list.filter((s) => s.seat_type === "OCI" || s.seat_type === "ForeignNational").length;
      if (fn > fnCap) push("INTAKE-003", "error", `OCI/FN seats ${fn}${tag} exceed permitted cap ${fnCap}`);
    }
  }
  return out;
}

// ---- national duplicate sweep ------------------------------------------------
const DUPE_FIELDS = ["id", "name", "institution_id", "institution_name", "programme_id", "programme_name",
  "enrolment_no", "status"];

export function duplicateApaars(students: Rec[]) {
  const active = students.filter((s) => s.status !== "Withdrawn");
  const out: { apaar_id: string; students: Rec[] }[] = [];
  for (const [apaar, list] of groupBy(active, (s) => s.apaar_id)) {
    if (str(apaar) === "" || list.length < 2) continue;
    out.push({ apaar_id: apaar, students: list.map((s) => slice(s, DUPE_FIELDS)) });
  }
  return out;
}

// ---- helpers -----------------------------------------------------------------
export function groupBy<T, K>(list: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

// Ruby Hash#slice: only keys that are present on the record.
export function slice(rec: Rec, keys: string[]): Rec {
  const out: Rec = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(rec, k)) out[k] = rec[k];
  return out;
}

function res(code: string, severity: Finding["severity"], message: string, field: string | null, rec: Rec,
  institutionId: string | null | undefined, programmeId?: string | null): Finding {
  return {
    code, severity, message, field,
    apaar_id: rec.apaar_id ?? null,
    institution_id: institutionId ?? null,
    programme_id: programmeId ?? rec.programme_id ?? null,
  };
}

// Calendar date as a day number, or null when not a valid YYYY-MM-DD date.
function parseDate(v: unknown): number | null {
  const s = str(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86400000;
}
