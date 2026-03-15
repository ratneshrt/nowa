import "dotenv/config";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { postVersions, posts } from "./schema";

type PostRecord = typeof posts.$inferSelect;
type PostVersionRecord = typeof postVersions.$inferSelect;
type PostEditRecord = PostVersionRecord & { isCurrent?: boolean };

type InsertPostParams = {
  telegramMessageId: number;
  authorTelegramId: number;
  content: string;
  timestamp: Date;
  origin?: "tg" | "cli";
};

type UpdatePostParams = {
  targetTelegramMessageId: number;
  newContent: string;
  editedBy: number;
  editedAt: Date;
};

type DeletePostParams = {
  targetTelegramMessageId: number;
  deletedAt: Date;
};

type PostTotals = {
  total: number;
  visible: number;
  deleted: number;
};

type DrizzleDb = ReturnType<typeof drizzle>;

let sharedPool: Pool | null = null;
let sharedDb: DrizzleDb | null = null;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not defined. Please set it before performing database operations."
    );
  }
  return databaseUrl;
}

function getDb(): DrizzleDb {
  if (sharedDb) {
    return sharedDb;
  }

  const databaseUrl = requireDatabaseUrl();
  sharedPool = new Pool({ connectionString: databaseUrl });
  sharedDb = drizzle(sharedPool);
  return sharedDb;
}

export async function shutdownDatabasePool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end().catch(() => {
      /* ignore */
    });
  }
  sharedPool = null;
  sharedDb = null;
}

/**
 * Opens a one-off pg client to verify whether the configured database is reachable.
 * Resolves if the connection and a simple `SELECT 1` succeed, otherwise rejects.
 */
export async function verifyDatabaseConnection(): Promise<void> {
  const db = getDb();
  await db.execute(sql`select 1`);
}

export async function insertNewPost(
  params: InsertPostParams
): Promise<PostRecord | null> {
  const db = getDb();

  const [inserted] = await db
    .insert(posts)
    .values({
      telegramMessageId: params.telegramMessageId,
      authorTelegramId: params.authorTelegramId,
      content: params.content,
      createdAt: params.timestamp,
      updatedAt: params.timestamp,
      editCount: 0,
      deleted: false,
      origin: params.origin ?? "cli",
    })
    .onConflictDoNothing({
      target: posts.telegramMessageId,
    })
    .returning();

  return inserted ?? null;
}

export async function getPostByTelegramMessageId(
  messageId: number
): Promise<PostRecord | null> {
  const db = getDb();
  const [post] = await db
    .select()
    .from(posts)
    .where(eq(posts.telegramMessageId, messageId))
    .limit(1);
  return post ?? null;
}

export async function updatePostContent(
  params: UpdatePostParams
): Promise<PostRecord | null> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(posts)
      .where(eq(posts.telegramMessageId, params.targetTelegramMessageId))
      .limit(1);

    if (!existing || existing.deleted) {
      return null;
    }

    await tx.insert(postVersions).values({
      postId: existing.id,
      editNumber: existing.editCount + 1,
      contentSnapshot: existing.content,
      editedBy: params.editedBy,
      editedAt: params.editedAt,
      origin: existing.origin,
    });

    const [updated] = await tx
      .update(posts)
      .set({
        content: params.newContent,
        updatedAt: params.editedAt,
        editCount: existing.editCount + 1,
      })
      .where(eq(posts.id, existing.id))
      .returning();

    return updated ?? null;
  });
}

export async function softDeletePost(
  params: DeletePostParams
): Promise<PostRecord | null> {
  const db = getDb();
  const [deletedPost] = await db
    .update(posts)
    .set({
      deleted: true,
      updatedAt: params.deletedAt,
    })
    .where(eq(posts.telegramMessageId, params.targetTelegramMessageId))
    .returning();
  return deletedPost ?? null;
}

export async function getAllPosts(): Promise<PostRecord[]> {
  const db = getDb();
  const rows = await db.select().from(posts).orderBy(desc(posts.createdAt));
  return rows;
}

export async function getAllEdits(
  telegramMessageId: number
): Promise<PostEditRecord[]> {
  const db = getDb();
  const [post] = await db
    .select({
      id: posts.id,
      content: posts.content,
      editCount: posts.editCount,
      authorTelegramId: posts.authorTelegramId,
      updatedAt: posts.updatedAt,
    })
    .from(posts)
    .where(eq(posts.telegramMessageId, telegramMessageId))
    .limit(1);

  if (!post) {
    return [];
  }

  const versions = await db
    .select()
    .from(postVersions)
    .where(eq(postVersions.postId, post.id))
    .orderBy(desc(postVersions.editNumber));

  const currentVersion: PostEditRecord = {
    id: post.id,
    postId: post.id,
    editNumber: post.editCount + 1,
    contentSnapshot: post.content,
    editedBy: post.authorTelegramId,
    editedAt: post.updatedAt,
    isCurrent: true,
  };

  return [currentVersion, ...versions];
}

export async function getPostTotals(): Promise<PostTotals> {
  const db = getDb();
  const [counts] = await db
    .select({
      total: sql<number>`count(*)`,
      deleted: sql<number>`count(*) filter (where ${posts.deleted} = true)`,
    })
    .from(posts);

  const total = counts?.total ?? 0;
  const deleted = counts?.deleted ?? 0;
  const visible = total - deleted;
  return { total, deleted, visible };
}
