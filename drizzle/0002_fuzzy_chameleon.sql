CREATE TYPE "public"."origin_type" AS ENUM('tg', 'cli');--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "origin" "origin_type" DEFAULT 'cli' NOT NULL;