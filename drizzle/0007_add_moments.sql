CREATE TABLE IF NOT EXISTS "moments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uid" text NOT NULL,
	"r2_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"caption" text,
	"lqip" text,
	"telegram_message_id" bigint,
	"origin" "origin_type",
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"purged_at" timestamp with time zone,
	CONSTRAINT "moments_uid_unique" UNIQUE("uid"),
	CONSTRAINT "moments_telegram_message_id_unique" UNIQUE("telegram_message_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moments_visible_created_idx" ON "moments" ("created_at" DESC) WHERE "deleted" = false;
