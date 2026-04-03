import { neon } from "@neondatabase/serverless";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Create the enum type if not exists
  await sql`DO $$ BEGIN
    CREATE TYPE origin_type AS ENUM ('tg', 'cli');
  EXCEPTION WHEN duplicate_object THEN null;
  END $$`;

  // Create posts table
  await sql`CREATE TABLE IF NOT EXISTS posts (
    id bigserial PRIMARY KEY,
    uid text NOT NULL UNIQUE,
    telegram_message_id bigint UNIQUE,
    author_telegram_id bigint,
    content text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    edit_count integer NOT NULL DEFAULT 0,
    deleted boolean NOT NULL DEFAULT false,
    origin origin_type NOT NULL DEFAULT 'cli'
  )`;

  // Create post_versions table
  await sql`CREATE TABLE IF NOT EXISTS post_versions (
    id bigserial PRIMARY KEY,
    post_id bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    edit_number integer NOT NULL,
    content_snapshot text NOT NULL,
    edited_by bigint,
    edited_at timestamptz NOT NULL,
    origin origin_type NOT NULL DEFAULT 'cli',
    CONSTRAINT post_versions_post_id_edit_number_idx UNIQUE (post_id, edit_number)
  )`;

  console.log("Tables created.");

  // Fetch from old NowEntry table
  const rows = await sql`SELECT id, content, "createdAt", "updatedAt" FROM "NowEntry" ORDER BY "createdAt" ASC`;
  console.log(`Found ${rows.length} entries in NowEntry — migrating...`);

  let migrated = 0;
  for (const row of rows) {
    await sql`
      INSERT INTO posts (uid, content, created_at, updated_at, edit_count, deleted, origin)
      VALUES (${row.id}, ${row.content}, ${row.createdAt}, ${row.updatedAt}, 0, false, 'cli')
      ON CONFLICT (uid) DO NOTHING
    `;
    migrated++;
  }

  const count = await sql`SELECT COUNT(*) as c FROM posts WHERE deleted = false`;
  console.log(`Done — migrated: ${migrated}, total active posts: ${(count[0] as any).c}`);
}

main().catch(console.error);
