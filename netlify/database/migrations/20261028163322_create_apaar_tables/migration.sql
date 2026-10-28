CREATE TABLE "audit" (
	"seq" serial PRIMARY KEY,
	"id" text NOT NULL UNIQUE,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"role" text NOT NULL,
	"action" text NOT NULL,
	"detail" text NOT NULL,
	"institution_id" text
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" text PRIMARY KEY,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programmes" (
	"id" text PRIMARY KEY,
	"institution_id" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" text PRIMARY KEY,
	"apaar_id" text DEFAULT '' NOT NULL,
	"institution_id" text DEFAULT '' NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"username" text NOT NULL UNIQUE,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"institution_id" text,
	"email" text
);
--> statement-breakpoint
CREATE INDEX "audit_institution_idx" ON "audit" ("institution_id");--> statement-breakpoint
CREATE INDEX "programmes_institution_idx" ON "programmes" ("institution_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX "students_apaar_idx" ON "students" ("apaar_id");--> statement-breakpoint
CREATE INDEX "students_institution_idx" ON "students" ("institution_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");