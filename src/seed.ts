// Deterministic demo repository — port of Store#seed in lib/store.rb.
// 16 AICTE-style institutions, programmes with approved intake, three
// admission-year cohorts (2023-2025) and a handful of deliberately injected
// anomalies so every validation rule visibly fires on the dashboards.
import { randomBytes } from "node:crypto";
import * as Apaar from "./apaar.js";
import type { Rec } from "./validation.js";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable, unique, random-looking ids: a counter through an odd-multiplier
// bijection on 32 bits (so seeding twice yields the same ids).
let idCounter = 0;
function seedId(prefix: string) {
  const n = (Math.imul(++idCounter, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
  return `${prefix}-${n.toString(16).toUpperCase().padStart(8, "0")}`;
}

export interface SeedData {
  institutions: Rec[];
  programmes: Rec[];
  students: Rec[];
  users: { id: string; username: string; password: string; role: string; name: string; institution_id: string | null; email: string }[];
}

export function buildSeed(): SeedData {
  idCounter = 0;
  const rng = mulberry32(20261019);
  const rand = () => rng();
  const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  const pick = <T>(list: T[]) => list[Math.floor(rng() * list.length)];
  const shuffle = <T>(list: T[]) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const instData: [number, string, string, string, string, number][] = [
    [104, "Indian Institute of Technology Delhi", "Delhi", "New Delhi", "Technical", 1961],
    [127, "College of Engineering Pune", "Maharashtra", "Pune", "Technical", 1854],
    [233, "PSG College of Technology", "Tamil Nadu", "Coimbatore", "Technical", 1951],
    [318, "Manipal Institute of Technology", "Karnataka", "Manipal", "Technical", 1957],
    [412, "Vishwakarma Institute of Technology", "Maharashtra", "Pune", "Technical", 1983],
    [507, "Thapar Institute of Engineering & Technology", "Punjab", "Patiala", "Technical", 1956],
    [621, "Birla Institute of Technology", "Jharkhand", "Ranchi", "Technical", 1964],
    [733, "Sardar Vallabhbhai National Institute of Technology", "Gujarat", "Surat", "Technical", 1961],
    [801, "National Institute of Technology Warangal", "Telangana", "Warangal", "Technical", 1971],
    [815, "Delhi Technological University", "Delhi", "New Delhi", "Technical", 1941],
    [822, "Amrita Vishwa Vidyapeetham", "Tamil Nadu", "Coimbatore", "Deemed", 1994],
    [839, "Jadavpur University", "West Bengal", "Kolkata", "University", 1955],
    [846, "College of Engineering Guindy, Anna University", "Tamil Nadu", "Chennai", "Technical", 1921],
    [858, "Thiagarajar College of Engineering", "Tamil Nadu", "Madurai", "Technical", 1957],
    [884, "Symbiosis Institute of Technology", "Maharashtra", "Pune", "Technical", 2008],
    [897, "Kalinga Institute of Industrial Technology", "Odisha", "Bhubaneswar", "Deemed", 2005],
  ];

  const institutions: Rec[] = instData.map(([code, name, state, city, type, est]) => ({
    id: `INS-${code}`, code, name, state, city, type, established: est, status: "Approved",
    api_key: `apk_${randomBytes(12).toString("hex")}`,
  }));

  const progCatalog: [string, string, number][] = [
    ["B.E. Computer Science and Engineering", "Undergraduate", 4],
    ["B.E. Electronics and Communication Engineering", "Undergraduate", 4],
    ["B.Tech Information Technology", "Undergraduate", 4],
    ["B.E. Mechanical Engineering", "Undergraduate", 4],
    ["B.E. Civil Engineering", "Undergraduate", 4],
    ["M.Tech Computer Science and Engineering", "Postgraduate", 2],
    ["MBA", "Postgraduate", 2],
  ];

  const programmes: Rec[] = [];
  institutions.forEach((ins, ii) => {
    progCatalog.forEach(([pname, level, dur], pi) => {
      if ((ii + pi) % 4 === 3) return; // not every institute runs every programme
      const base = [60, 60, 40, 30, 60, 50, 45][(ii + pi) % 7];
      programmes.push({
        id: `PRG-${ins.code}-${pi + 1}`, institution_id: ins.id, name: pname, level, duration_years: dur,
        approved_intake: base, supernumerary_cap: Math.round(base * 0.1),
        nri_cap: [4, 6, 8][pi % 3], fn_cap: [2, 3, 4][pi % 3],
      });
    });
  });

  const first = ["Aarav", "Aditi", "Rohan", "Sneha", "Karthik", "Ananya", "Vikram", "Priya", "Arjun", "Meera",
    "Siddharth", "Kavya", "Rahul", "Nisha", "Arun", "Divya", "Manoj", "Swathi", "Nikhil", "Pooja",
    "Rakesh", "Shreya", "Varun", "Anjali", "Imran", "Fatima", "Tarun", "Lakshmi", "Gaurav", "Ritika"];
  const last = ["Sharma", "Gupta", "Verma", "Singh", "Reddy", "Nair", "Iyer", "Patel", "Joshi", "Chatterjee",
    "Banerjee", "Desai", "Kulkarni", "Menon", "Pillai", "Rao", "Das", "Ghosh", "Mishra", "Kapoor"];
  const foreignNats = ["Nepali", "German", "Emirati", "American", "Nigerian"];
  const years = [2023, 2024, 2025];
  const seqByKey = new Map<string, number>();
  const students: Rec[] = [];

  // Approved intake is sanctioned PER ACADEMIC YEAR, so students are seeded as
  // one cohort per programme per year — the same unit validation counts in.
  programmes.forEach((prog, pi) => {
    const insIdx = institutions.findIndex((i) => i.id === prog.institution_id);
    const ins = institutions[insIdx];
    const slot = insIdx + 1;

    years.forEach((yr, yi) => {
      const overflow = pi === 2 && yi === years.length - 1; // one cohort deliberately over intake
      const fill = 0.62 + rand() * 0.4;
      const target = overflow ? prog.approved_intake + prog.supernumerary_cap + 9
        : Math.max(Math.round(prog.approved_intake * fill), 8);

      // seat mix: quota seats stay within that year's sanctioned caps
      const sn = Math.min(Math.round(target * 0.08), prog.supernumerary_cap);
      const nri = Math.min(Math.round(target * 0.04), prog.nri_cap);
      const fn = Math.min(Math.round(target * 0.03), prog.fn_cap);
      const fnSeat = rand() > 0.5 ? "OCI" : "ForeignNational";
      const seatPool = shuffle([
        ...Array(target - sn - nri - fn).fill("Regular"),
        ...Array(sn).fill("Supernumerary"),
        ...Array(nri).fill("NRI"),
        ...Array(fn).fill(fnSeat),
      ]);
      // earlier cohorts have had time to graduate; the newest one is mostly active
      const statusMix = yr === years[0] ? ["Active", "Active", "Graduated", "Graduated", "Withdrawn"]
        : yr === years[1] ? ["Active", "Active", "Active", "Graduated", "Withdrawn"]
        : ["Active", "Active", "Active", "Active", "Active", "Withdrawn"];

      for (let si = 0; si < target; si++) {
        const key = `${ins.id}/${yr}`;
        const seq = (seqByKey.get(key) || 0) + 1;
        seqByKey.set(key, seq);
        const mo = int(1, 12);
        const dy = int(1, 28);
        const seat = seatPool[si];
        // NRI seats belong to Indian citizens abroad; OCI/FN seats to foreign nationals.
        const nat = seat === "OCI" || seat === "ForeignNational" ? pick(foreignNats) : "Indian";
        students.push({
          id: seedId("STU"),
          apaar_id: Apaar.generate(slot, yr, seq),
          name: `${pick(first)} ${pick(last)}`,
          dob: `${yr - int(17, 21)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`,
          gender: pick(["M", "F"]),
          category: pick(["General", "General", "OBC", "OBC", "SC", "ST", "EWS"]),
          nationality: nat,
          seat_type: seat,
          oci_card_no: seat === "OCI" ? `OCI${int(100000, 999999)}` : null,
          passport_no: seat === "ForeignNational" ? `P${int(1000000, 9999999)}` : null,
          institute_sc_no: `ISC${ins.code}${int(10000, 99999)}`,
          programme_id: prog.id,
          programme_name: prog.name,
          institution_id: ins.id,
          institution_name: ins.name,
          enrolment_no: `${ins.code}/${yr}/${pad(seq, 3)}`,
          admission_year: yr,
          admission_date: `${yr}-${pad(mo, 2)}-${pad(dy, 2)}`,
          email: `${pick(first).toLowerCase()}.${int(100, 999)}@example.edu.in`,
          phone: String(int(6000000000, 9999999999)),
          address: `${int(1, 999)}, ${pick(["Gandhi", "Nehru", "Patel", "Ambedkar", "Subhash"])} Nagar, ${ins.city}`,
          status: overflow ? "Active" : pick(statusMix), // keep the overflow cohort counting
          consent: { granted: rand() > 0.04, ts: now, scope: "AICTE+EmployerVerification" },
          created_at: `${yr}-${pad(mo, 2)}-${pad(dy, 2)}T10:00:00Z`,
          updated_at: now,
        });
      }
    });
  });

  // ---- injected anomalies (so dashboards show real detections) -----------
  // 1) same APAAR enrolled at two institutions (classic cross-institution dupe)
  const src = students.find((s) => s.programme_id.includes("-1"))!;
  const otherIns = institutions.find((i) => i.id !== src.institution_id)!;
  const otherProg = programmes.find((p) => p.institution_id === otherIns.id && p.name === src.programme_name) ||
    programmes.find((p) => p.institution_id === otherIns.id)!;
  students.push({
    ...src, id: seedId("STU"), institution_id: otherIns.id, institution_name: otherIns.name,
    programme_id: otherProg.id, programme_name: otherProg.name, enrolment_no: `${otherIns.code}/2024/888`,
    name: `${src.name} (Dup)`, status: "Active",
  });

  // 2) corrupt check digit
  const five = students[5];
  students.push({ ...five, id: seedId("STU"), apaar_id: five.apaar_id.slice(0, 11) + ((Number(five.apaar_id[11]) + 5) % 10) });

  // 3) garbage APAAR (too short) + missing fields
  const p3 = programmes[3];
  students.push({
    id: seedId("STU"), apaar_id: "1220231", name: "Incomplete Record", dob: "", gender: "M", category: "General",
    nationality: "Indian", seat_type: "Regular", institute_sc_no: "ISC12799999",
    programme_id: p3.id, programme_name: p3.name, institution_id: p3.institution_id,
    institution_name: institutions.find((i) => i.id === p3.institution_id)!.name,
    enrolment_no: "127/2024/999", admission_year: 2024, admission_date: "2024-07-01",
    email: "not-an-email", phone: "123", address: "", status: "Active",
    consent: { granted: false, ts: null, scope: null }, created_at: now, updated_at: now,
  });

  // 4) OCI seat with Indian nationality + missing OCI card, re-registered under
  //    a NEW enrolment number (so DUP-001/ENR-001 have a live demo)
  const nine = students[9];
  students.push({
    ...nine, id: seedId("STU"), seat_type: "OCI", nationality: "Indian", oci_card_no: null,
    enrolment_no: String(nine.enrolment_no).replace(/\/\d+$/, "/997"),
  });

  const users = [
    { id: "USR-1", username: "aicte.admin", password: "demo123", role: "AICTE_ADMIN",
      name: "AICTE Central Repository Admin", institution_id: null, email: "admin@aicte.org.in" },
    { id: "USR-2", username: "cope.pune", password: "demo123", role: "INSTITUTION",
      name: "Registrar, COEP Pune", institution_id: "INS-127", email: "registrar@coeptech.ac.in" },
    { id: "USR-3", username: "mit.manipal", password: "demo123", role: "INSTITUTION",
      name: "MIT Manipal Data Cell", institution_id: "INS-318", email: "datacell@mit.edu" },
    { id: "USR-4", username: "employer.demo", password: "demo123", role: "VERIFIER",
      name: "TCS Campus Hiring Verification", institution_id: null, email: "verify@tcs.com" },
  ];

  return { institutions, programmes, students, users };
}
