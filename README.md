# APAAR × AICTE — Student Data Management & Verification System

A complete, runnable implementation of the AICTE problem statement: an APAAR-keyed national
student repository for AICTE-approved institutions, with automated anomaly detection,
real-time dashboards, authorized verification via signed verifiable credentials, and a full
audit trail.

**Zero external dependencies** — stock Ruby (WEBrick) + a static single-page app. No
`bundle install`, no database server, no build step.

---

## Quick start

```bash
ruby server.rb 8787
```

Then open:

| URL | What |
| --- | --- |
| <http://127.0.0.1:8787/> | Landing page — problem, pipeline, feature tour, architecture |
| <http://127.0.0.1:8787/portal.html> | The portal (login → dashboard) |
| <http://127.0.0.1:8787/architecture.html> | Rendered system architecture (L1–L6) |

Data seeds automatically on first boot into `data/db.json` — **~9,800 student records across
16 AICTE-approved institutions**, built as three admission-year cohorts (2023–2025) against
each programme's annually sanctioned intake, plus a handful of deliberately seeded
anomalies so every validation rule visibly fires on the dashboards. Delete `data/db.json`
to reseed (the seed is deterministic, so every clone sees the same repository).

Run the API smoke test (server must be up):

```bash
ruby test/smoke_test.rb    # 24 checks: auth, RBAC, upsert, all rule families, exports
```

---

## Demo credentials

All accounts use password `demo123`.

| Username | Role | Sees |
| --- | --- | --- |
| `aicte.admin` | `AICTE_ADMIN` | National scope — every institution |
| `cope.pune` | `INSTITUTION` | COEP Pune only |
| `mit.manipal` | `INSTITUTION` | MIT Manipal only |
| `employer.demo` | `VERIFIER` | Academic PII only — no contact details |

The login form is pre-filled with `cope.pune` / `demo123`.

---

## What's implemented

**Institution → upload → validate → verify → repository → analytics**, per the problem
statement's expected-solution pipeline.

- **Secure upload API** — single-record and bulk-batch endpoints, session auth + RBAC,
  institution row-scoping enforced in the service layer.
- **Full data fields** — approved intake, actual enrolment, supernumerary seats, NRI,
  OCI status (+ card number), Foreign National status (+ passport), plus category, DOB,
  gender, admission year/date, contact.
- **11 code-tagged validation rules** — invalid/missing APAAR (format + Luhn checksum +
  admission-year coherence), duplicate APAAR within an institution, **duplicate enrolment
  across institutions**, admissions exceeding approved intake **for the admission year**
  (caught at upload time, before the commit), supernumerary / NRI / OCI / FN quota caps
  per cohort, missing mandatory fields, inconsistent data (DOB after admission,
  nationality-vs-seat-type conflicts, missing OCI card or passport), duplicate enrolment
  number, and missing student consent.
- **Real-time dashboards** — KPI cards, canvas charts (admissions by year, category
  distribution, seat-type mix, enrolment vs approved intake), and a live anomaly feed.
- **Authorized verification** — any stakeholder looks up an APAAR ID (spaces or raw
digits — pasted IDs are normalised) and receives the record wrapped in a **W3C-style
Verifiable Credential** signed with HMAC-SHA256; the signature is re-validated server-side
on every read and a receipt is written to the audit log. A **formal printable certificate**
— tricolour band, national emblem, embossed AICTE seal, dual signature lines and a
tamper-evident QR digest of the credential — renders the APAAR ID alongside the
enrolment ID for degree-awarding bodies (A4-landscape print layout).
- **Reports** — enrolment-monitoring CSV and full-records CSV export.
- **Audit trail** — append-only log of every login, upload, verification, consent change
  and export, with actor, role, scope and UTC timestamp.
- **Consent** — captured at upload, revocable later; verifiers never see contact extras.

---

## API

Auth: send `X-Auth-Token: <token>` on API calls, or `?auth_token=<token>` for browser
`<a href>` CSV downloads (a navigation cannot set headers). Errors are JSON:
`{ "error": "…", "findings": [ … ] }`.

Bulk upload wraps rows in a `records` array:

```bash
curl -s -X POST "$BASE/api/students/bulk?auth_token=$TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"records":[{"apaar_id":"122026990019","name":"Aditi Sharma", \
       "dob":"2004-04-12","gender":"F","category":"General", \
       "institution_id":"INS-127","programme_id":"PRG-127-1","enrolment_no":"127/2026/901", \
       "admission_year":2026,"admission_date":"2026-07-15", \
       "seat_type":"Regular","nationality":"Indian"}]}'
# → {"results":[{"row":1,"status":"accepted","findings":[]}],"accepted":1,"rejected":0}
```

The full request/response shapes are tabulated in
[ARCHITECTURE.md §6](ARCHITECTURE.md#6-api-surface-integration-contract).

| Group | Endpoints |
| --- | --- |
| Auth | `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/me` |
| Reference | `GET /api/institutions` · `GET /api/programmes` |
| Students | `GET /api/students` (`q`, `institution_id`, `programme_id`, `status`, `page`, `per`) · `POST /api/students` · `POST /api/students/bulk` · `POST /api/validate` (dry-run) |
| Monitoring | `GET /api/dashboard` · `GET /api/issues` · `GET /api/audit` |
| Verification | `GET /api/verify?apaar_id=` (public format check, no PII) · `POST /api/verify` (authorized, signed credential) |
| Consent & reports | `POST /api/consent` · `GET /api/reports/enrolment.csv` · `GET /api/records.csv` |

### Try it from the shell

```bash
BASE=http://127.0.0.1:8787

# 1. sign in
TOKEN=$(curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"cope.pune","password":"demo123"}' | ruby -rjson -e 'puts JSON.parse(STDIN.read)["token"]')

# 2. national KPIs
curl -s "$BASE/api/dashboard?auth_token=$TOKEN" | ruby -rjson -e 'puts JSON.parse(STDIN.read)["kpis"]'

# 3. submit a record (dry-run first)
curl -s -X POST "$BASE/api/validate?auth_token=$TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"apaar_id":"122026990028","name":"Aditi Sharma","dob":"2004-04-12","gender":"F",
       "category":"General","institution_id":"INS-127","programme_id":"PRG-127-1","enrolment_no":"127/2026/902",
       "admission_year":2026,"admission_date":"2026-07-15","seat_type":"Regular",
       "nationality":"Indian","consent":true}'
# → {"apaar":{"valid":true,"errors":[]},"findings":[],"ok":true}
# (a bad check digit returns  APAAR-001  "failed Luhn verification"  — try 122024100427)

# 4. verify (issues a signed credential) — use any APAAR from the Students view,
#    pasted with or without spaces
curl -s -X POST "$BASE/api/verify?auth_token=$TOKEN" \
  -H 'Content-Type: application/json' -d '{"apaar_id":"12 2023 01196 7"}'
```

---

## Project layout

```
server.rb                 # thin entry point → lib/server (usage: ruby server.rb [port])
lib/
  server.rb               # WEBrick setup, routing, RBAC, auth, audit, CSV, static SPA
  store.rb                # JSON document store + deterministic seed (PostgreSQL stand-in)
  validation.rb           # validation engine — 11 code-tagged rules
  apaar.rb                # APAAR generation, Luhn checksum, masking, normalisation
test/
  smoke_test.rb           # 24-check API smoke suite (stdlib only)
public/
  index.html              # landing page
  portal.html             # SPA shell (login → dashboard)
  architecture.html       # rendered system architecture
  css/main.css            # design system + print certificate
  js/charts.js            # dependency-free canvas chart library
  js/app.js               # SPA logic
data/
  db.json                 # seeded store (created on first run; git-ignored)
```

---

## Technical approach — what software powers what

| Layer | Choice | Why |
| --- | --- | --- |
| **Backend runtime** | Ruby 3-compatible code on **stdlib WEBrick** (`lib/server.rb`) | Runs on any machine with Ruby installed — no gems, no `bundle install`, no container needed for the demo |
| **API style** | Plain REST over JSON, token auth via `auth_token` header | Trivially consumable from institutional ERP/MIS systems, curl, Postman or any HTTP client |
| **Persistence** | `Store` — a mutex-guarded JSON document store (`data/db.json`) | Interface mirrors a PostgreSQL schema 1:1 so production swaps internals without touching routes or rules |
| **Validation engine** | Pure-Ruby rules module (`lib/validation.rb`) with O(n) hash indexes (by APAAR, enrolment, programme) | Full national sweep of 10k+ records in <100 ms; rule codes (DUP-001 … CONSENT-001) give AICTE a stable policy vocabulary |
| **APAAR logic** | Format builder, Luhn-10 check digit, display-grouping, input normalisation (`lib/apaar.rb`) | Pasted IDs like `12 2023 01196 7` verify exactly like raw digits — the reported copy-paste bug |
| **Credentials** | W3C-style Verifiable Credential, **HMAC-SHA256** signature (`OpenSSL` from stdlib) | Tamper-evident and offline-verifiable without trusting the transport |
| **Front end** | Dependency-free **vanilla JavaScript** SPA (`public/js/app.js`) | No build step, no npm; open the folder anywhere or serve it as-is |
| **UI / styling** | Hand-rolled **CSS design system** (`public/css/main.css`) — CSS variables, responsive grid, dedicated `@media print` A4-landscape certificate | Government-grade formal certificate plus dark-glass portal, zero CSS frameworks |
| **Charts** | Custom **canvas chart library** (`public/js/charts.js`) — bars, donuts, gauges | No charting dependency; renders KPI dashboards offline |
| **Testing** | `test/smoke_test.rb` — 24 API checks, stdlib `net/http` only | One command proves auth, RBAC, upsert, every rule family and exports on a fresh clone |

---

## Design notes

- **APAAR is the national key.** It anchors cross-institution duplicate detection, which
  enrolment numbers alone cannot provide.
- **Errors block commits.** A `force=true` override exists but is audited and stays visible
  in the anomaly feed — nothing is silently swallowed.
- **Institution isolation is enforced server-side**, before serialization, so a crafted API
  call cannot escape its tenant.
- **Credentials are portable.** The HMAC proof on each VC can be checked offline without
  trusting the transport or a live API call.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full L1–L6 reference architecture, data
flow, security model, production scale-out path, and a requirement-traceability matrix.

---

## Production path

This build is a single-process demo. The `Store` interface mirrors a PostgreSQL schema
one-to-one; production swaps the internals for PostgreSQL (row-level security by
institution) + Redis sessions + S3 audit archive behind horizontally scaled stateless
API replicas, with an async bulk-ingest queue. Hardening checklist, observability plan and
the OpenAPI integration contract are in [ARCHITECTURE.md](ARCHITECTURE.md#5-deployment--scale-out-path).
