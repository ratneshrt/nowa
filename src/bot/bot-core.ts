import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Telegraf, Context } from "telegraf";
import { posts } from "../db/schema";
import {
  insertNewPost,
  softDeletePost,
  updatePostContent,
} from "../db/db-ops";

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

type MessageCategory = "command" | "plain-text" | "reply" | "unknown";

type PostRecordPayload = {
  telegramMessageId: number;
  authorTelegramId: number;
  content: string;
  createdAt: string;
  updatedAt: string;
  editCount: number;
  deleted: boolean;
};

type StructuredLogEntry = {
  category: MessageCategory;
  author: {
    id: number | undefined;
    username: string | undefined;
  };
  payload: PostRecordPayload | null;
  missingFields: string[];
  receivedAt: string;
  actionSummary?: string;
  referenceMessageId?: number | null;
  referenceTag?: string;
};

type ReferenceableMessage = {
  message_id: number;
  date?: number;
  reply_to_message?: ReferenceableMessage;
};

function isReplyMessage(ctx: Context): boolean {
  const message = ctx.message;
  if (!message) return false;
  return Boolean("reply_to_message" in message && message.reply_to_message);
}

function isCommandMessage(ctx: Context): boolean {
  const message = ctx.message;
  if (!message || !("text" in message)) return false;

  const entities = message.entities ?? [];
  return entities.some(
    (entity) => entity.type === "bot_command" && entity.offset === 0
  );
}

function categorizeMessage(ctx: Context): MessageCategory {
  if (isReplyMessage(ctx)) return "reply";
  if (isCommandMessage(ctx)) return "command";
  if (ctx.message && "text" in ctx.message) return "plain-text";
  return "unknown";
}

function buildPostRecordPayload(ctx: Context): {
  payload: PostRecordPayload | null;
  missingFields: string[];
} {
  const missingFields: string[] = [];
  let hasFatalMissingField = false;
  const message = ctx.message;

  const telegramMessageId = message?.message_id;
  if (typeof telegramMessageId !== "number") {
    missingFields.push("telegramMessageId");
    hasFatalMissingField = true;
  }

  const authorTelegramId = ctx.from?.id;
  if (typeof authorTelegramId !== "number") {
    missingFields.push("authorTelegramId");
    hasFatalMissingField = true;
  }

  let createdAtISO: string | undefined;
  if (typeof message?.date === "number") {
    createdAtISO = new Date(message.date * 1000).toISOString();
  } else {
    missingFields.push("createdAt");
    createdAtISO = new Date().toISOString();
  }

  const content =
    message && "text" in message
      ? message.text
      : message
      ? JSON.stringify(message)
      : undefined;
  if (!content) {
    missingFields.push("content");
    hasFatalMissingField = true;
  }

  if (hasFatalMissingField) {
    return { payload: null, missingFields };
  }

  const payload: PostRecordPayload = {
    telegramMessageId: telegramMessageId!,
    authorTelegramId: authorTelegramId!,
    content: content!,
    createdAt: createdAtISO!,
    updatedAt: createdAtISO!,
    editCount: 0,
    deleted: false,
  };

  return { payload, missingFields };
}

function getMessageText(message: Context["message"]): string | null {
  if (message && "text" in message && typeof message.text === "string") {
    const trimmed = message.text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function isDeleteCommand(ctx: Context): boolean {
  const message = ctx.message;
  if (!message || !("text" in message)) return false;
  const entities = message.entities ?? [];
  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0
  );
  if (!commandEntity) {
    return false;
  }
  const commandText = message.text.slice(
    commandEntity.offset,
    commandEntity.offset + commandEntity.length
  );
  return commandText === "/delete";
}

function buildReferenceTag(
  message: ReferenceableMessage | null | undefined
): string {
  const isoTimestamp =
    typeof message?.date === "number"
      ? new Date(message.date * 1000).toISOString()
      : new Date().toISOString();
  const messageIdLabel =
    typeof message?.message_id === "number"
      ? message.message_id.toString()
      : "unknown";
  return `${isoTimestamp}:${messageIdLabel}`;
}

function getReplyTarget(
  message: Context["message"]
): ReferenceableMessage | null {
  if (
    message &&
    typeof message === "object" &&
    "reply_to_message" in message
  ) {
    const replyCandidate = (message as { reply_to_message?: unknown })
      .reply_to_message;
    if (
      replyCandidate &&
      typeof replyCandidate === "object" &&
      "message_id" in replyCandidate
    ) {
      return replyCandidate as ReferenceableMessage;
    }
  }
  return null;
}

function isOriginalPostReference(
  message: ReferenceableMessage | null
): boolean {
  if (!message) return false;
  return !message.reply_to_message;
}

function formatHumanTimestamp(date: Date): string {
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const day = date.getUTCDate().toString().padStart(2, "0");
  const month = monthNames[date.getUTCMonth()];
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  return `${day} ${month} ${hours}:${minutes}:${seconds}`;
}

function buildHumanReadableReferenceLabel(
  message: ReferenceableMessage | null | undefined
): string {
  const messageIdLabel =
    typeof message?.message_id === "number"
      ? message.message_id.toString()
      : "unknown";
  const timestamp =
    typeof message?.date === "number"
      ? new Date(message.date * 1000)
      : new Date();
  return `${messageIdLabel} - ${formatHumanTimestamp(timestamp)}`;
}

async function replyToSpecificMessage(
  ctx: Context,
  chatId: number | string | undefined,
  messageId: number,
  text: string
): Promise<void> {
  if (chatId === undefined) {
    await ctx.reply(text);
    return;
  }

  await ctx.telegram.sendMessage(
    chatId,
    text,
    {
      reply_to_message_id: messageId,
      allow_sending_without_reply: true,
    } as Record<string, unknown>
  );
}

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

    const category = categorizeMessage(ctx);
    const { payload, missingFields } = buildPostRecordPayload(ctx);
    const structuredLog: StructuredLogEntry = {
      category,
      author: {
        id: ctx.from?.id,
        username: ctx.from?.username,
      },
      payload,
      missingFields,
      receivedAt: new Date().toISOString(),
    };

    const incomingMessage = ctx.message;
    if (!incomingMessage) {
      console.warn("Received message update without message payload.");
      return;
    }

    const chatId = ctx.chat?.id;

    if (isCommandMessage(ctx) && !isDeleteCommand(ctx)) {
      structuredLog.actionSummary = "Rejected unsupported command.";
      structuredLog.referenceMessageId = incomingMessage.message_id;
      structuredLog.referenceTag = "n/a";
      console.log(
        "Structured log entry:",
        JSON.stringify(structuredLog, null, 2)
      );
      await replyToSpecificMessage(
        ctx,
        chatId,
        incomingMessage.message_id,
        "command not found"
      );
      return;
    }

    const timestamp = formatTimestamp(ctx);
    const authorLabel = formatAuthor(ctx);
    const content =
      "text" in incomingMessage
        ? incomingMessage.text
        : JSON.stringify(incomingMessage, null, 2);

    console.log(`Message category received: ${category}`);
    console.log(
      `[${timestamp}] message #${incomingMessage.message_id} from ${authorLabel}:`,
      content
    );
    const replyTarget = getReplyTarget(incomingMessage);
    let responseDescription = "No action taken.";
    let referenceMessage: ReferenceableMessage | null =
      incomingMessage ?? null;

    try {
      if (isDeleteCommand(ctx)) {
        if (!replyTarget) {
          responseDescription = "Delete command must reply to a post.";
        } else if (!isOriginalPostReference(replyTarget)) {
          responseDescription =
            "Please reply to the original post (not an edit) to delete.";
        } else {
          referenceMessage = replyTarget;
          const deleted = await softDeletePost({
            targetTelegramMessageId: replyTarget.message_id,
            deletedAt: new Date(),
          });
          responseDescription = deleted
            ? "Post marked as deleted."
            : "No matching post found to delete.";
        }
      } else if (replyTarget) {
        referenceMessage = replyTarget;
        const newContent = getMessageText(incomingMessage);
        const editorId = ctx.from?.id;
        if (!newContent) {
          responseDescription = "Edit reply must include text content.";
        } else if (typeof editorId !== "number") {
          responseDescription = "Missing editor id for edit action.";
        } else {
          const edited = await updatePostContent({
            targetTelegramMessageId: replyTarget.message_id,
            newContent,
            editedBy: editorId,
            editedAt:
              typeof incomingMessage.date === "number"
                ? new Date(incomingMessage.date * 1000)
                : new Date(),
          });
          responseDescription = edited
            ? "Post updated."
            : "No matching post found to update.";
        }
      } else {
        if (!payload) {
          responseDescription = missingFields.length
            ? `Missing required fields: ${missingFields.join(", ")}.`
            : "Unable to derive mandatory fields from message.";
        } else {
          const inserted = await insertNewPost({
            telegramMessageId: payload.telegramMessageId,
            authorTelegramId: payload.authorTelegramId,
            content: payload.content,
            timestamp: new Date(payload.createdAt),
            origin: "tg",
          });
          if (inserted) {
            responseDescription = "Post stored.";
          } else {
            responseDescription =
              "Post already exists for this telegram message ID.";
          }
        }
      }
    } catch (error) {
      console.error("Failed to process message:", error);
      responseDescription =
        "Internal error while handling this update. Please retry.";
    }

    const referenceTag = buildReferenceTag(referenceMessage);
    const humanReferenceLabel =
      buildHumanReadableReferenceLabel(referenceMessage);
    structuredLog.actionSummary = responseDescription;
    structuredLog.referenceMessageId = referenceMessage?.message_id ?? null;
    structuredLog.referenceTag = referenceTag;
    console.log("Structured log entry:", JSON.stringify(structuredLog, null, 2));

    await replyToSpecificMessage(
      ctx,
      chatId,
      incomingMessage.message_id,
      `${humanReferenceLabel} | ${responseDescription}`
    );
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



