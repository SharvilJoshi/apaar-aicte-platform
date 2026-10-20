# System Architecture

## APAAR-based Student Data Management & Verification System — AICTE

**Version 1.0 · Reference architecture for the demo build**

---

## 1. Purpose & scope

AICTE receives student information through heterogeneous channels — PGDM institutions file
detailed student data annually, while other approved institutions submit aggregate enrolment
counts during approval. This platform collapses both paths into a single **APAAR-keyed
national student repository**: institutions push student-level records after admissions close,
every record is validated against a code-tagged rule registry before it can commit, and any
authorized stakeholder (AICTE, institutions, employers, regulators, awarding bodies) can
verify an individual record in real time against a signed, portable credential.

The architecture below is what the running demo implements today, plus the explicit
production scale-out path.

---

## 2. Layered architecture (L1 – L6)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ L6  CLIENTS / CONSUMERS                                                     │
│     Institution Portals · AICTE Console · Verifier Apps · Public Quick-Check│
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  HTTPS · JSON
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ L5  API EDGE  (single entry point for every request)                        │
│     Auth Middleware · RBAC Guard · Institution Scoping · Audit Interceptor   │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ L4  DOMAIN SERVICES                                                         │
│     Student · Verification · Analytics · Report · Institution · Audit       │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ L3  VALIDATION & ANOMALY ENGINE  (runs on every write, sweepable repo-wide) │
│     Rule Registry (10 code-tagged rules) · Hash Index Builder                │
│     Severity Resolver · Issue Store                                          │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ L2  PERSISTENCE                                                             │
│     Student Master (APAAR-keyed) · Institution Directory · Programme Master │
│     Append-only Audit Log · User & Role Store · HMAC Key · Session Store    │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ L1  EXTERNAL INTEGRATIONS                                                   │
│     APAAR / DigiLocker · AICTE Approval MIS · Institution ERP/SIS           │
│     Degree-Awarding Bodies (certificate printing)                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

### L6 — Clients / consumers

| Client | Who | Capability |
| --- | --- | --- |
| Institution Portal | Registrar / data-cell staff | Single & bulk student submission, intake dashboards, consent management |
| AICTE Console | AICTE administrators | National analytics, anomaly feed, policy reports, audit oversight |
| Verifier Apps | Employers, regulators, awarding bodies | APAAR lookup + credential signature check |
| Public Quick-Check | Anyone | Unauthenticated APAAR **format/checksum** validation — returns zero PII |

### L5 — API edge

The only entry point for every request. Four cross-cutting concerns run in order on every
call:

1. **Auth Middleware** — session token issued on credential check (48-hex, 8-hour TTL),
   server-side session store, immediate revocation on logout. Token travels as
   `X-Auth-Token` header or `auth_token` query param.
2. **RBAC Guard** — a role × route matrix. Roles: `AICTE_ADMIN`, `INSTITUTION`,
   `VERIFIER`, plus a `public` tier for format-only checks.
3. **Institution scoping** — for `INSTITUTION` callers, query results are filtered to the
   caller's `institution_id` **before serialization**, so a tenant physically cannot read
   another institution's rows.
4. **Audit interceptor** — every mutating or verifying action appends an immutable event
   (actor, role, action, detail, scope, UTC timestamp).

### L4 — Domain services

| Service | Responsibility |
| --- | --- |
| **Student** | Upsert single record · bulk batch accept/reject with per-row findings · paginated search with filters · consent grant/revoke |
| **Verification** | Authorized record retrieval by APAAR ID · role-scoped PII exposure · HMAC-SHA256 credential signing · signature re-validation on every read |
| **Analytics** | KPI aggregation · intake utilisation · category/seat/state distributions · institution league table · anomaly grouping |
| **Report** | Enrolment CSV · full-records CSV · governance indicators for accreditation & policy review |
| **Institution** | Approved-institution directory · programme master with sanctioned intake, supernumerary, NRI/OCI/FN caps |
| **Audit** | Append-only event log with actor, role, action, scope and UTC timestamp |

### L3 — Validation & anomaly engine

Runs on **every write** (single or bulk row) and can also sweep the whole repository. An
O(n) hash index keyed by APAAR, by enrolment number and by programme id is built per
sweep — the full repository sweep stays sub-second even at ≈10 k records.

**Rule registry — 11 code-tagged rules** (intake and quota caps are evaluated per
academic year, since AICTE sanctions intake annually):

| Code | Detects | Severity |
| --- | --- | --- |
| `APAAR-001` | Invalid/missing APAAR ID — not 12 digits, bad Luhn check digit, wrong prefix | error |
| `APAAR-002` | APAAR year inconsistent with recorded admission year | error |
| `DUP-001` | Duplicate APAAR **within the same institution** | error |
| `DUP-002` | Potential duplicate enrolment **across institutions** (national-level) | error |
| `INTAKE-001` | A year's cohort enrolment exceeds approved intake + permitted supernumerary | error |
| `INTAKE-002` | A year's cohort above approved intake but within supernumerary headroom | warning |
| `INTAKE-003` | A year's supernumerary / NRI / OCI / FN seat counts exceed their permitted caps | error |
| `DATA-001` | Missing mandatory fields (name, DOB, gender, category, programme, enrolment no.) | error |
| `DATA-002` | Inconsistent data — DOB after admission, invalid category, nationality/seat-type conflict, missing OCI card or passport, bad contact fields | error/warning |
| `ENR-001` | Duplicate enrolment number within an institution | error |
| `CONSENT-001` | Student consent for repository storage + authorised verification not on file (requirement 8) | warning |

**Severity resolver:** `error` blocks commit (a `force=true` override is possible but is
audited and remains visible in the anomaly feed) · `warning` is flagged for review but
commits. Persisted findings feed the anomaly feed, dashboard badges and the Validation
Center.

### L2 — Persistence

| Store | Contents |
| --- | --- |
| Student Master | APAAR-keyed student records + consent state — the national repository |
| Institution Directory | Approved institutions, state/city, institution codes & API keys |
| Programme Master | Programmes with approved intake, supernumerary, NRI, OCI/FN caps |
| Append-only Audit Log | Capped rolling window, actor + action + detail + UTC ts |
| User & Role Store | Credential records mapped to RBAC roles and institution scope |
| HMAC Signing Key | Issuer secret for credential signatures — server-side only, never exposed |
| Session Store | Token → user + expiry; logout invalidates immediately |

> **Demo vs production:** the demo persists to a single JSON document store behind a
> `Store` class whose interface (read/insert/update, collection iteration, mutex-guarded
> writes) mirrors the production PostgreSQL schema one-to-one. Production swaps the
> internals for PostgreSQL tables with row-level security by institution — no service code
> changes.

### L1 — External integrations

| System | Integration |
| --- | --- |
| APAAR / DigiLocker | Authoritative APAAR issuance & identity resolution (reference integration) |
| AICTE Approval MIS | Approved-institution & sanctioned-intake master feeds |
| Institution ERP / SIS | REST push of post-admission batches using institution API keys |
| Degree-Awarding Bodies | Verify + print APAAR ID alongside enrolment ID on certificates |

---

## 3. End-to-end data flow

This is the expected-solution pipeline, as implemented:

```
 Institution → Student Data Upload → APAAR Validation → Data Verification
      → AICTE Central Repository → Analytics & Monitoring → Authorized Verification
```

Mapped onto actual requests:

```
STEP 1  Institution submits      POST /api/students (single) · POST /api/students/bulk
        ⌄
STEP 2  Auth & scope             token → role → institution filter applied
        ⌄
STEP 3  APAAR validation         format · Luhn checksum · admission-year coherence · dup indexes
        ⌄
STEP 4  Intake & quota checks    intake + supernumerary headroom · NRI/OCI/FN caps
        ⌄
STEP 5  Commit + audit           upsert to student master · audit event written
        ⌄
STEP 6  Analytics refresh        KPIs · charts · anomaly feed update in real time
        ⌄
STEP 7  Authorized verify        signed W3C-style VC + receipt returned to stakeholder
```

**Write path (happy):** validate → `202` accepted → findings returned → issues recomputed →
dashboard badges update live.

**Write path (rejected):** `HTTP 422` with a `findings` array carrying one entry per rule.
The institution may force-commit — that override is audited and stays visible in the
anomaly feed, so nothing is ever silently swallowed.

**Verify path:** `POST /api/verify` → record + W3C-style VC + HMAC proof → signature
re-checked server-side → verification receipt written to audit.

---

## 4. Security, privacy & governance

### Authentication
- Session tokens (48-hex, 8-hour TTL) issued on credential check.
- Server-side session store → immediate revocation on logout.
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/me`.
- Token via `auth_token` / `X-Auth-Token` header.
- `401` on expiry → forced re-login.

### Authorization (RBAC)
Every route declares allowed roles; institution callers are additionally **row-scoped** to
their `institution_id`.

| Role | Scope |
| --- | --- |
| `AICTE_ADMIN` | National scope — all institutions |
| `INSTITUTION` | Own records only |
| `VERIFIER` | Academic PII only — no contact/demographic extras |
| public | APAAR format check only, **zero PII** |

### Verifiable credentials
Each verified record is wrapped in a W3C-style credential and signed with
**HMAC-SHA256 over the canonical JSON**:

```json
{
  "id": "urn:uuid:…",
  "type": ["VerifiableCredential", "AICTEStudentRecordCredential"],
  "issuer": "did:web:apaar.aicte.org.in",
  "credentialSubject": { "apaarId": "122021202014", "…": "…" },
  "proof": { "type": "HmacSha2562020", "proofValue": "HMAC(canonical)" }
}
```
- `proofValue = HMAC(canonical JSON)` — re-verified on every read.
- Issuer DID + key id in `proof`.
- Copyable into external wallets / presented to third parties.

### Privacy & consent
- Data-subject consent captured at upload time (timestamp + scope stored), revocable later.
- Verifier view returns **academic fields only** — no email/phone/address.
- Public quick-check returns no PII at all.
- Aligned to DPDP Act consent workflows.

### Audit trail
Append-only; each event carries actor, role, action, human-readable detail, scope and UTC
timestamp. Action set:

`LOGIN` · `LOGOUT` · `STUDENT_CREATE` / `STUDENT_UPDATE` · `BULK_UPLOAD` · `VERIFY` ·
`CONSENT_UPDATE` · `REPORT_EXPORT`

### Integrity controls
- Errors block commits by default — `422` with per-rule findings.
- `force=true` → explicit, deliberate, recorded override — never silent.
- 10-rule registry, code-tagged; counts surfaced as "rule coverage" on dashboards.

### Production hardening checklist
Argon2id password hashing · mTLS for institution API keys · rate limiting per API key ·
field-level encryption for PII at rest · daily signed snapshots for offline verification ·
OWASP ASVS L2 review · DPDP Act consent workflows.

---

## 5. Deployment & scale-out path

**Demo deployment (this build)**
Ruby WEBrick API + JSON document store + static SPA — zero external dependencies, single
process, runs anywhere.

**Production deployment**
```
                     ┌─ L7 load balancer ─┐
                     │                    │
        Institution  ▼   API replicas     ▼   AICTE console
        ERP/SIS ───►[ stateless app containers × N ]───┐
                                                      │
              ┌───────────────┬───────────────────────┤
              ▼               ▼                       ▼
        PostgreSQL        Redis sessions          S3 audit archive
        (student master,                        (immutable, signed
         row-level security                      daily snapshots)
         by institution)
```
- Horizontal API replicas behind an L7 balancer.
- Async bulk-ingest queue with per-batch validation workers (the sync bulk endpoint in the
  demo becomes a job submit + poll/webhook).
- PostgreSQL with row-level security keyed by `institution_id`.
- Redis for shared session store; S3 (Object Lock) for the immutable audit archive.

**Scale & interoperability**
- OpenAPI 3 spec published for institutional ERP integration.
- Webhook callbacks for verification events.
- Batch ingest queue decouples institution submission spikes from the analytical reads.

**Observability**
Structured JSON logs with trace id · RED metrics per endpoint · anomaly-rate SLO (alerts
on rule-count spikes) · audit-log completeness monitor · nightly APAAR integrity sweep.

---

## 6. API surface (integration contract)

| Group | Endpoints |
| --- | --- |
| **Auth** | `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/me` |
| **Reference data** | `GET /api/institutions` · `GET /api/programmes` |
| **Students** | `GET /api/students` (`q`, `institution_id`, `programme_id`, `status`, `page`, `per`) · `POST /api/students` (upsert) · `POST /api/students/bulk` · `POST /api/validate` (dry-run) |
| **Monitoring** | `GET /api/dashboard` · `GET /api/issues` · `GET /api/audit` |
| **Verification** | `GET /api/verify?apaar_id=` (public format check) · `POST /api/verify` (authorized, signed credential) |
| **Consent & reports** | `POST /api/consent` · `GET /api/reports/enrolment.csv` · `GET /api/records.csv` |

**Auth:** `auth_token` header or query param on every non-public route.

**Errors are JSON** — bulk and single uploads return per-row / per-rule `findings` arrays:

```json
{ "error": "…", "findings": [ { "code": "DUP-001", "severity": "error", "message": "…" } ] }
```

**Request shapes** — the payloads the endpoints accept:

| Endpoint | Method | Body |
| --- | --- | --- |
| `/api/auth/login` | POST | `{ "username", "password" }` → `{ token, user }` |
| `/api/students` | POST | one student object (or `{ "student": {...}, "force": true }`) |
| `/api/students/bulk` | POST | `{ "records": [ <student>, … ] }` → `{ results, accepted, rejected }` |
| `/api/validate` | POST | one student object (or `{ "record": {...} }`) → `{ apaar, findings, ok }` |
| `/api/verify` | POST | `{ "apaar_id": "12…" }` → `{ found, student, credential, signature_valid }` |
| `/api/consent` | POST | `{ "apaar_id", "granted", "scope" }` |

A student object carries: `apaar_id`, `name`, `dob`, `gender`, `category`,
`programme_id`, `enrolment_no`, `admission_year`, `admission_date`, `seat_type`,
`nationality`, optional `email` / `phone` / `oci_card_no` / `passport_no`, and `consent`.
`institution_id` is injected server-side for `INSTITUTION` callers and **required** for
`AICTE_ADMIN` (bulk rows without it are rejected with `DATA-001`).

Each entry in `results` is `{ row, apaar_id, name, status: "accepted"|"rejected", findings: [...] }`;
a row with any `severity: "error"` finding is rejected unless `force: true` is set on the
single-record endpoint (that override is audited).

---

## 7. Data model (core entities)

```
institution  1───* programme            programme carries intake caps:
   │               │                    approved_intake, supernumerary,
   │               │                    nri_cap, oci_cap, fn_cap
   │               │
   └───── 1 ── * student *──1 ── programme
                  │
                  ├── apaar_id   (12 digits, Luhn-protected, national key)
                  ├── enrolment_no, admission_year, admission_date
                  ├── category, gender, dob, seat_type, nationality
                  ├── oci_card_no / passport_no   (conditional)
                  └── consent { granted, scope, timestamp }

session    token ──▶ user { username, password, role, institution_id }
audit      append-only { actor, role, action, detail, scope, ts }
issue      finding  { code, severity, message, field, apaar_id, institution_id }
```

The **APAAR ID** is the join key across every table and the anchor for cross-institution
duplicate detection (`DUP-002`).

---

## 8. Key design decisions

| Decision | Rationale |
| --- | --- |
| **APAAR as primary key** | National academic identity gives one stable identifier across institutions, solving the cross-institution duplicate problem that enrolment numbers cannot. |
| **Validate-before-commit, errors block** | AICTE's core need is *authentic* records. Letting errors through and reporting later reproduces today's problem. Overrides exist but are audited and visible. |
| **Code-tagged rule registry** | Rule codes (`INTAKE-001` …) give AICTE a stable vocabulary for policy reporting and let dashboards count rule coverage. |
| **Row-scoping in the service layer, not the UI** | Institution isolation is enforced before serialization, so a crafted API call cannot escape its tenant. |
| **Signed W3C-style VCs** | Verifiers check the HMAC proof offline without trusting the transport or a live API call — this is what makes records *verifiable* rather than merely *stored*. |
| **Append-only audit** | Regulatory requirement (req. 8) and the basis for forensic accountability. |
| **`Store` interface mirroring PostgreSQL** | The JSON store is a drop-in for the demo; production swaps internals without touching services. |
| **Single-process, zero-dependency demo** | Runs anywhere with stock Ruby — no install friction for evaluation. |

---

## 9. Requirement traceability

| # | Requirement | Where implemented |
| --- | --- | --- |
| 1 | Secure platform/API for student upload keyed by APAAR | `POST /api/students`, `/api/students/bulk`, auth + RBAC at L5 |
| 2 | Intake, enrolment, supernumerary, NRI, OCI, FN fields | Programme master caps + student `seat_type`/`nationality`/`oci_card_no`/`passport_no` |
| 3 | Automated validation (dupes, invalid APAAR, excess intake, inconsistencies, cross-institution dupes, consent) | L3 rule registry: `APAAR-001/002`, `DUP-001/002`, `INTAKE-001/002/003`, `DATA-001/002`, `ENR-001`, `CONSENT-001` |
| 4 | Dashboards for AICTE and institutions, real time | `GET /api/dashboard` → Overview with KPIs, 5 charts, live anomaly feed |
| 5 | Secure verification for authorized stakeholders | `POST /api/verify` — RBAC-gated, signed credential |
| 6 | Verifiable student records linked to academic identity | W3C-style VC with HMAC-SHA256 proof, re-checked on read |
| 7 | Integration/API capability with institutional & AICTE systems | REST API surface (§6), institution API keys, OpenAPI path |
| 8 | Security, privacy, authentication, RBAC, audit trails, consent | L5 middleware chain, consent store, append-only audit log |
| 9 | Reports for policy, accreditation, monitoring, regulation | `GET /api/reports/enrolment.csv`, `/api/records.csv`, Reports view |
| 10 | Print/display APAAR ID alongside student ID on certificates | Printable certificate in Verify view + `GET /api/verify?apaar_id=` for awarding bodies |

---

## 10. Component map (source)

```
server.rb                 # thin entry point → lib/server
lib/
  server.rb               # WEBrick setup, routing, RBAC, auth, audit, CSV, static SPA
  store.rb                # JSON document store + seed data (PostgreSQL stand-in)
  validation.rb           # L3 rule registry — 10 code-tagged rules
  apaar.rb                # APAAR generation, Luhn checksum, masking, formatting
public/
  index.html              # landing page (problem, pipeline, features, architecture link)
  portal.html             # SPA shell (login → dashboard)
  architecture.html       # this architecture, rendered visually
  css/main.css            # design system — gov-tech visual language
  js/charts.js            # dependency-free canvas chart library
  js/app.js               # SPA logic — views, upload, validation, verify, reports, audit
```
