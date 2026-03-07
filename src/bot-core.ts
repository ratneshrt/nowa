import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Telegraf, Context } from "telegraf";
import { posts } from "./db/schema";

type AllowedUserMap = Record<string, true>;

function buildAllowedUsers(): AllowedUserMap {
  const map: AllowedUserMap = {};
  const raw = process.env.ALLOWED_USERNAMES ?? "";

  raw
    .split(",")
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean)
    .forEach((username) => {
      map[username] = true;
    });

  return map;
}

const allowedUsers = buildAllowedUsers();

function isUserAllowed(ctx: Context): boolean {
  const username = ctx.from?.username?.toLowerCase();
  if (!username) {
    return false;
  }
  return Boolean(allowedUsers[username]);
}

const exampleTimestamp = new Date();

const examplePost = {
  telegramMessageId: 500999001,
  authorTelegramId: 777111222,
  content: `Example post created via seed helper at ${exampleTimestamp.toISOString()}`,
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp,
  editCount: 0,
  deleted: false,
} as const;

export async function insertExamplePost(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is missing. Please set it before seeding data.");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  try {
    const [inserted] = await db
      .insert(posts)
      .values(examplePost)
      .onConflictDoNothing({
        target: posts.telegramMessageId,
      })
      .returning();

    if (inserted) {
      console.log("Inserted post:", inserted);
    } else {
      console.log(
        "Post already existed for telegram_message_id:",
        examplePost.telegramMessageId.toString()
      );
    }
  } finally {
    await pool.end();
  }
}

function formatAuthor(ctx: Context): string {
  if (ctx.from?.username) return `@${ctx.from.username}`;
  if (ctx.from?.first_name || ctx.from?.last_name) {
    return `${ctx.from?.first_name ?? ""} ${ctx.from?.last_name ?? ""}`.trim();
  }
  return `user-${ctx.from?.id ?? "unknown"}`;
}

function formatTimestamp(ctx: Context): string {
  const unixSeconds = ctx.message?.date;
  if (unixSeconds) {
    return new Date(unixSeconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

export async function startLoggingBot(): Promise<void> {
  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    throw new Error("BOT_TOKEN is missing. Set it in your environment to run the bot.");
  }

  const bot = new Telegraf(botToken);

  bot.on("message", async (ctx) => {
    if (!isUserAllowed(ctx)) {
      console.warn(
        "Unauthorized message from",
        ctx.from?.username ?? ctx.from?.id ?? "unknown user"
      );
      await ctx.reply("unauthorized");
      return;
    }

    const timestamp = formatTimestamp(ctx);
    const authorLabel = formatAuthor(ctx);
    const content =
      "text" in ctx.message
        ? ctx.message.text
        : JSON.stringify(ctx.message, null, 2);

    console.log(
      `[${timestamp}] message #${ctx.message.message_id} from ${authorLabel}:`,
      content
    );
    await ctx.reply("received");
  });

  await bot.launch();
  console.log("Telegraf bot is running (long polling). Press Ctrl+C to stop.");

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, stopping bot...`);
    bot.stop(signal);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  if (process.argv.includes("--seed-example")) {
    insertExamplePost()
      .then(() => console.log("Seed complete."))
      .catch((error) => {
        console.error("Failed to insert example post:", error);
        process.exitCode = 1;
      });
  } else {
    startLoggingBot().catch((error) => {
      console.error("Bot failed to start:", error);
      process.exitCode = 1;
    });
  }
}
