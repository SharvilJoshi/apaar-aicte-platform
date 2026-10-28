import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Key/value platform settings: the credential HMAC secret, issuer DID and the
// seed marker. Mirrors the `settings` block of the original data/db.json.
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});

// Reference data and student records keep their full document in `data` (the
// same shape the API returns), with the columns needed for lookups pulled out.
export const institutions = pgTable("institutions", {
  id: text().primaryKey(),
  data: jsonb().notNull(),
});

export const programmes = pgTable(
  "programmes",
  {
    id: text().primaryKey(),
    institutionId: text("institution_id").notNull(),
    data: jsonb().notNull(),
  },
  (t) => [index("programmes_institution_idx").on(t.institutionId)],
);

export const students = pgTable(
  "students",
  {
    id: text().primaryKey(),
    apaarId: text("apaar_id").notNull().default(""),
    institutionId: text("institution_id").notNull().default(""),
    data: jsonb().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("students_apaar_idx").on(t.apaarId),
    index("students_institution_idx").on(t.institutionId),
  ],
);

export const users = pgTable("users", {
  id: text().primaryKey(),
  username: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text().notNull(),
  name: text().notNull(),
  institutionId: text("institution_id"),
  email: text(),
});

export const sessions = pgTable(
  "sessions",
  {
    token: text().primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_expires_idx").on(t.expiresAt)],
);

// Append-only audit trail. `seq` gives a stable newest-first order.
export const audit = pgTable(
  "audit",
  {
    seq: serial().primaryKey(),
    id: text().notNull().unique(),
    ts: timestamp({ withTimezone: true }).notNull().defaultNow(),
    actor: text().notNull(),
    role: text().notNull(),
    action: text().notNull(),
    detail: text().notNull(),
    institutionId: text("institution_id"),
  },
  (t) => [index("audit_institution_idx").on(t.institutionId)],
);

