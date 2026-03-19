import "dotenv/config";
import { nanoid } from "nanoid";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { posts } from "../../db/schema";

const exampleTimestamp = new Date();

export async function insertExamplePost() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is missing. Please set it before seeding data.");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  const telegramMessageId = 500999001;

  try {
    const [inserted] = await db
      .insert(posts)
      .values({
        uid: nanoid(10),
        telegramMessageId,
        authorTelegramId: 777111222,
        content: `Example post created via seed helper at ${exampleTimestamp.toISOString()}`,
        createdAt: exampleTimestamp,
        updatedAt: exampleTimestamp,
        editCount: 0,
        deleted: false,
      })
      .onConflictDoNothing({
        target: posts.telegramMessageId,
      })
      .returning();

    if (inserted) {
      console.log("Inserted post:", inserted);
    } else {
      console.log("Post already existed for telegram_message_id:", telegramMessageId.toString());
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  insertExamplePost()
    .then(() => console.log("Seed complete."))
    .catch((error) => {
      console.error("Failed to insert example post:", error);
      process.exitCode = 1;
    });
}
