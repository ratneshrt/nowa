import { neon } from "@neondatabase/serverless";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Make origin column nullable
  await sql`ALTER TABLE posts ALTER COLUMN origin DROP NOT NULL`;
  await sql`ALTER TABLE posts ALTER COLUMN origin DROP DEFAULT`;
  console.log("origin column is now nullable");

  // Null out migrated entries — old cuid UIDs are 25 chars (start with 'c')
  // New nanoid UIDs from the worker are exactly 10 chars
  const result = await sql`
    UPDATE posts
    SET origin = NULL
    WHERE length(uid) > 10
    RETURNING uid
  `;
  console.log(`Cleared origin on ${result.length} migrated entries`);

  // Verify
  const counts = await sql`
    SELECT origin, COUNT(*) as c FROM posts GROUP BY origin ORDER BY origin
  `;
  console.log("Origin distribution:", counts);
}

main().catch(console.error);
