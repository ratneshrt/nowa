ALTER TABLE "post_versions" ALTER COLUMN "edited_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "updated_at" DROP DEFAULT;