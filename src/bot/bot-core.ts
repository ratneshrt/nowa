import "dotenv/config";
import { nanoid } from "nanoid";
import { Telegraf, Context } from "telegraf";
import {
  getLastPosts,
  getPostByUid,
  insertNewPost,
  restorePost,
  softDeletePost,
  softDeletePostByUid,
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

const KNOWN_COMMANDS = new Set(["delete", "which", "last", "restore"]);

type ReferenceableMessage = {
  message_id: number;
  date?: number;
  reply_to_message?: ReferenceableMessage;
};

function isUserAllowed(ctx: Context): boolean {
  const username = ctx.from?.username?.toLowerCase();
  if (!username) return false;
  return Boolean(allowedUsers[username]);
}

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

function parseCommandName(ctx: Context): string | null {
  const message = ctx.message;
  if (!message || !("text" in message)) return null;
  const entities = message.entities ?? [];
  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0
  );
  if (!commandEntity) return null;
  const raw = message.text.slice(
    commandEntity.offset + 1,
    commandEntity.offset + commandEntity.length
  );
  return raw.split("@")[0].toLowerCase();
}

function parseCommandArg(ctx: Context): string | null {
  const message = ctx.message;
  if (!message || !("text" in message)) return null;
  const entities = message.entities ?? [];
  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0
  );
  if (!commandEntity) return null;
  const after = message.text
    .slice(commandEntity.offset + commandEntity.length)
    .trim();
  return after.length > 0 ? after : null;
}

function getReplyTarget(
  message: Context["message"]
): ReferenceableMessage | null {
  if (
    message &&
    typeof message === "object" &&
    "reply_to_message" in message
  ) {
    const candidate = (message as { reply_to_message?: unknown })
      .reply_to_message;
    if (
      candidate &&
      typeof candidate === "object" &&
      "message_id" in candidate
    ) {
      return candidate as ReferenceableMessage;
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

function getMessageText(message: Context["message"]): string | null {
  if (message && "text" in message && typeof message.text === "string") {
    const trimmed = message.text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function formatBotTimestamp(date: Date): string {
  const day = date.getUTCDate().toString().padStart(2, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const year = date.getUTCFullYear().toString().slice(2);
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function formatPostMessage(content: string, createdAt: Date, uid: string): string {
  return `${content}\n-- ${formatBotTimestamp(createdAt)} | ${uid}`;
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

async function sendMessage(
  ctx: Context,
  chatId: number | string | undefined,
  replyToMessageId: number,
  text: string
): Promise<void> {
  if (chatId === undefined) {
    await ctx.reply(text);
    return;
  }
  await ctx.telegram.sendMessage(chatId, text, {
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: true,
  } as Record<string, unknown>);
}

export async function startLoggingBot(): Promise<void> {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "BOT_TOKEN is missing. Set it in your environment to run the bot."
    );
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

    const incomingMessage = ctx.message;
    if (!incomingMessage) {
      console.warn("Received message update without message payload.");
      return;
    }

    const chatId = ctx.chat?.id;
    const timestamp = formatTimestamp(ctx);
    const authorLabel = formatAuthor(ctx);
    const content =
      "text" in incomingMessage
        ? incomingMessage.text
        : JSON.stringify(incomingMessage, null, 2);

    console.log(
      `[${timestamp}] message #${incomingMessage.message_id} from ${authorLabel}:`,
      content
    );

    const replyTarget = getReplyTarget(incomingMessage);
    let response = "no action taken";

    try {
      if (isCommandMessage(ctx)) {
        const commandName = parseCommandName(ctx);
        const commandArg = parseCommandArg(ctx);

        if (!commandName || !KNOWN_COMMANDS.has(commandName)) {
          response = "error | command not found";
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }

        if (commandName === "delete") {
          if (commandArg) {
            const deleted = await softDeletePostByUid(commandArg);
            response = deleted
              ? `${deleted.uid} | deleted`
              : "error | post not found";
          } else if (replyTarget) {
            if (!isOriginalPostReference(replyTarget)) {
              response = "error | reply to the original post to delete";
            } else {
              const deleted = await softDeletePost({
                targetTelegramMessageId: replyTarget.message_id,
                deletedAt: new Date(),
              });
              response = deleted
                ? `${deleted.uid} | deleted`
                : "error | post not found";
            }
          } else {
            response = "error | reply to a post or provide a post id";
          }
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }

        if (commandName === "which") {
          if (!commandArg) {
            response = "error | provide a post id";
            await sendMessage(ctx, chatId, incomingMessage.message_id, response);
            return;
          }
          const post = await getPostByUid(commandArg);
          if (!post) {
            response = "post not found";
          } else if (post.deleted) {
            response = "post is deleted";
          } else {
            response = formatPostMessage(post.content, post.createdAt, post.uid);
          }
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }

        if (commandName === "last") {
          const n = commandArg ? Math.min(parseInt(commandArg, 10) || 1, 10) : 1;
          const lastPosts = await getLastPosts(n);
          if (lastPosts.length === 0) {
            await sendMessage(ctx, chatId, incomingMessage.message_id, "no posts found");
            return;
          }
          for (const post of lastPosts) {
            await sendMessage(
              ctx,
              chatId,
              incomingMessage.message_id,
              formatPostMessage(post.content, post.createdAt, post.uid)
            );
          }
          return;
        }

        if (commandName === "restore") {
          if (!commandArg) {
            response = "error | provide a post id";
            await sendMessage(ctx, chatId, incomingMessage.message_id, response);
            return;
          }
          const restored = await restorePost(commandArg);
          response = restored
            ? `${restored.uid} | restored`
            : "error | post not found";
          await sendMessage(ctx, chatId, incomingMessage.message_id, response);
          return;
        }
      } else if (replyTarget) {
        const newContent = getMessageText(incomingMessage);
        const editorId = ctx.from?.id;
        if (!newContent) {
          response = "error | edit reply must include text content";
        } else if (typeof editorId !== "number") {
          response = "error | missing editor id";
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
          response = edited ? `${edited.uid} | updated` : "error | post not found";
        }
        await sendMessage(ctx, chatId, incomingMessage.message_id, response);
        return;
      } else {
        const telegramMessageId = incomingMessage.message_id;
        const authorTelegramId = ctx.from?.id;
        const text = getMessageText(incomingMessage);
        const messageDate =
          typeof incomingMessage.date === "number"
            ? new Date(incomingMessage.date * 1000)
            : new Date();

        if (!text) {
          response = "error | message must contain text";
        } else if (typeof telegramMessageId !== "number") {
          response = "error | could not read message id";
        } else {
          const uid = nanoid(10);
          const inserted = await insertNewPost({
            uid,
            telegramMessageId,
            authorTelegramId,
            content: text,
            timestamp: messageDate,
            origin: "tg",
          });
          response = inserted
            ? `${inserted.uid} | inserted successfully`
            : "error | post already exists for this message";
        }
        await sendMessage(ctx, chatId, incomingMessage.message_id, response);
        return;
      }
    } catch (error) {
      console.error("Failed to process message:", error);
      response = "error | internal error, please retry";
      await sendMessage(ctx, chatId, incomingMessage.message_id, response);
    }
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
  startLoggingBot().catch((error) => {
    console.error("Bot failed to start:", error);
    process.exitCode = 1;
  });
}
