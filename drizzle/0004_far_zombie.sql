ALTER TABLE "posts" ALTER COLUMN "telegram_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "author_telegram_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "uid" text NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_uid_unique" UNIQUE("uid");