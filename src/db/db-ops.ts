import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { Pool, neonConfig, neon } from "@neondatabase/serverless";
import { moments, postVersions, posts } from "./schema";

// In Node.js (local dev), inject the ws package as the WebSocket implementation.
// In CF Workers, globalThis.WebSocket is natively available so this block is skipped.
if (typeof globalThis.WebSocket === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  neonConfig.webSocketConstructor = require("ws");
}

type PostRecord = typeof posts.$inferSelect;
type PostVersionRecord = typeof postVersions.$inferSelect;
type PostEditRecord = PostVersionRecord & { isCurrent?: boolean };

type InsertPostParams = {
  uid: string;
  telegramMessageId?: number;
  authorTelegramId?: number;
  content: string;
  timestamp: Date;
  origin: "tg" | "cli" | "web";
};

type UpdatePostParams = {
  targetTelegramMessageId: number;
  newContent: string;
  editedBy: number;
  editedAt: Date;
};

type UpdatePostByUidParams = {
  uid: string;
  newContent: string;
  editedBy?: number;
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

type PaginatedPosts = {
  posts: PostRecord[];
  nextCursor: number | null;
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

// Called by the CF Worker middleware on every request.
// Uses neon-http (stateless fetch) — safe to reinitialize per request because
// neon-http has no persistent connection. This avoids CF Workers' I/O isolation
// error ("Cannot perform I/O on behalf of a different request") that occurs when
// a WebSocket-backed Pool is cached from a previous request's context.
export function initDb(connectionString: string): void {
  sharedDb = drizzleHttp(neon(connectionString)) as unknown as DrizzleDb;
}

export async function shutdownDatabasePool(): Promise<void> {
  await sharedPool?.end();
  sharedPool = null;
  sharedDb = null;
}

export async function verifyDatabaseConnection(): Promise<void> {
  const db = getDb();
  await db.execute(sql`select 1`);
}

export async function insertNewPost(
  params: InsertPostParams
): Promise<PostRecord | null> {
  const db = getDb();

  const query = db.insert(posts).values({
    uid: params.uid,
    telegramMessageId: params.telegramMessageId ?? null,
    authorTelegramId: params.authorTelegramId ?? null,
    content: params.content,
    createdAt: params.timestamp,
    updatedAt: params.timestamp,
    editCount: 0,
    deleted: false,
    origin: params.origin,
  });

  const [inserted] = params.telegramMessageId
    ? await query
        .onConflictDoNothing({ target: posts.telegramMessageId })
        .returning()
    : await query.returning();

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

export async function getPostByUid(uid: string): Promise<PostRecord | null> {
  const db = getDb();
  const [post] = await db
    .select()
    .from(posts)
    .where(eq(posts.uid, uid))
    .limit(1);
  return post ?? null;
}

export async function updatePostContent(
  params: UpdatePostParams
): Promise<PostRecord | null> {
  const db = getDb();

  // No transaction — Neon HTTP driver doesn't support them in CF Workers.
  // Sequential queries are safe here (single-user bot).
  const [existing] = await db
    .select()
    .from(posts)
    .where(eq(posts.telegramMessageId, params.targetTelegramMessageId))
    .limit(1);

  if (!existing || existing.deleted) return null;

  await db.insert(postVersions).values({
    postId: existing.id,
    editNumber: existing.editCount + 1,
    contentSnapshot: existing.content,
    editedBy: params.editedBy,
    editedAt: params.editedAt,
    origin: existing.origin,
  });

  const [updated] = await db
    .update(posts)
    .set({
      content: params.newContent,
      updatedAt: params.editedAt,
      editCount: existing.editCount + 1,
    })
    .where(eq(posts.id, existing.id))
    .returning();

  return updated ?? null;
}

export async function updatePostContentByUid(
  params: UpdatePostByUidParams
): Promise<PostRecord | null> {
  const db = getDb();

  const [existing] = await db
    .select()
    .from(posts)
    .where(eq(posts.uid, params.uid))
    .limit(1);

  if (!existing || existing.deleted) return null;

  await db.insert(postVersions).values({
    postId: existing.id,
    editNumber: existing.editCount + 1,
    contentSnapshot: existing.content,
    editedBy: params.editedBy ?? null,
    editedAt: params.editedAt,
    origin: existing.origin,
  });

  const [updated] = await db
    .update(posts)
    .set({
      content: params.newContent,
      updatedAt: params.editedAt,
      editCount: existing.editCount + 1,
    })
    .where(eq(posts.id, existing.id))
    .returning();

  return updated ?? null;
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

export async function softDeletePostByUid(
  uid: string
): Promise<PostRecord | null> {
  const db = getDb();
  const [deletedPost] = await db
    .update(posts)
    .set({
      deleted: true,
      updatedAt: new Date(),
    })
    .where(eq(posts.uid, uid))
    .returning();
  return deletedPost ?? null;
}

export async function restorePost(uid: string): Promise<PostRecord | null> {
  const db = getDb();
  const [restored] = await db
    .update(posts)
    .set({
      deleted: false,
      updatedAt: new Date(),
    })
    .where(eq(posts.uid, uid))
    .returning();
  return restored ?? null;
}

export async function getAllPosts(): Promise<PostRecord[]> {
  const db = getDb();
  const rows = await db.select().from(posts).orderBy(desc(posts.createdAt));
  return rows;
}

export async function getAllPostsPaginated(
  limit: number,
  cursor?: number
): Promise<PaginatedPosts> {
  const db = getDb();

  const conditions = [eq(posts.deleted, false)];
  if (cursor) conditions.push(lt(posts.id, cursor));
  const where = and(...conditions);

  const rows = await db
    .select()
    .from(posts)
    .where(where)
    .orderBy(desc(posts.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return { posts: data, nextCursor };
}

export async function getDeletedPostsPaginated(
  limit: number,
  cursor?: number
): Promise<PaginatedPosts> {
  const db = getDb();

  const conditions = [eq(posts.deleted, true)];
  if (cursor) conditions.push(lt(posts.id, cursor));
  const where = and(...conditions);

  const rows = await db
    .select()
    .from(posts)
    .where(where)
    .orderBy(desc(posts.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return { posts: data, nextCursor };
}

export async function getLastPosts(n: number): Promise<PostRecord[]> {
  const db = getDb();
  const count = Math.min(Math.max(1, n), 10);
  return db
    .select()
    .from(posts)
    .where(eq(posts.deleted, false))
    .orderBy(desc(posts.createdAt))
    .limit(count);
}

export async function getLastDeletedPosts(n: number): Promise<PostRecord[]> {
  const db = getDb();
  const count = Math.min(Math.max(1, n), 10);
  return db
    .select()
    .from(posts)
    .where(eq(posts.deleted, true))
    .orderBy(desc(posts.createdAt))
    .limit(count);
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
      origin: posts.origin,
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
    editedBy: post.authorTelegramId ?? null,
    editedAt: post.updatedAt,
    origin: post.origin,
    isCurrent: true,
  };

  return [currentVersion, ...versions];
}

export async function getAllEditsByUid(
  uid: string
): Promise<PostEditRecord[]> {
  const db = getDb();
  const [post] = await db
    .select({
      id: posts.id,
      content: posts.content,
      editCount: posts.editCount,
      authorTelegramId: posts.authorTelegramId,
      updatedAt: posts.updatedAt,
      origin: posts.origin,
    })
    .from(posts)
    .where(eq(posts.uid, uid))
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
    editedBy: post.authorTelegramId ?? null,
    editedAt: post.updatedAt,
    origin: post.origin,
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

// ── Moments ────────────────────────────────────────────────────────────

type MomentRecord = typeof moments.$inferSelect;

type InsertMomentParams = {
  uid: string;
  r2Key: string;
  width: number;
  height: number;
  caption: string | null;
  lqip: string | null;
  telegramMessageId?: number;
  origin: "tg" | "cli" | "web";
  timestamp: Date;
};

export async function insertMoment(
  params: InsertMomentParams
): Promise<MomentRecord | null> {
  const db = getDb();
  const [inserted] = await db
    .insert(moments)
    .values({
      uid: params.uid,
      r2Key: params.r2Key,
      width: params.width,
      height: params.height,
      caption: params.caption,
      lqip: params.lqip,
      telegramMessageId: params.telegramMessageId ?? null,
      origin: params.origin,
      createdAt: params.timestamp,
      updatedAt: params.timestamp,
    })
    .onConflictDoNothing({ target: moments.telegramMessageId })
    .returning();
  return inserted ?? null;
}

export async function getLatestMoments(n: number): Promise<MomentRecord[]> {
  const db = getDb();
  const count = Math.min(Math.max(1, n), 200);
  return db
    .select()
    .from(moments)
    .where(and(eq(moments.deleted, false), isNull(moments.purgedAt)))
    .orderBy(desc(moments.createdAt))
    .limit(count);
}

export async function getMomentByUid(uid: string): Promise<MomentRecord | null> {
  const db = getDb();
  const [row] = await db.select().from(moments).where(eq(moments.uid, uid)).limit(1);
  return row ?? null;
}

export async function getMomentByTelegramMessageId(
  messageId: number
): Promise<MomentRecord | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(moments)
    .where(eq(moments.telegramMessageId, messageId))
    .limit(1);
  return row ?? null;
}

export async function updateMomentCaption(
  uid: string,
  caption: string | null
): Promise<MomentRecord | null> {
  const db = getDb();
  const [updated] = await db
    .update(moments)
    .set({ caption, updatedAt: new Date() })
    .where(and(eq(moments.uid, uid), eq(moments.deleted, false)))
    .returning();
  return updated ?? null;
}

// Marks the moment deleted and purged in one go — the caller removes the R2
// object, so there is nothing left to restore.
export async function deleteMoment(uid: string): Promise<MomentRecord | null> {
  const db = getDb();
  const now = new Date();
  const [deleted] = await db
    .update(moments)
    .set({ deleted: true, purgedAt: now, updatedAt: now })
    .where(and(eq(moments.uid, uid), eq(moments.deleted, false)))
    .returning();
  return deleted ?? null;
}

// Moments that have rotated off the home page (not in the newest `keep`) and
// are older than `olderThan`, whose R2 object still exists.
export async function getPurgeableMoments(
  keep: number,
  olderThan: Date
): Promise<MomentRecord[]> {
  const db = getDb();
  const newest = db
    .select({ id: moments.id })
    .from(moments)
    .where(eq(moments.deleted, false))
    .orderBy(desc(moments.createdAt))
    .limit(keep);

  return db
    .select()
    .from(moments)
    .where(
      and(
        isNull(moments.purgedAt),
        lt(moments.createdAt, olderThan),
        notInArray(moments.id, newest)
      )
    );
}

export async function markMomentsPurged(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db
    .update(moments)
    .set({ purgedAt: new Date() })
    .where(inArray(moments.id, ids));
}
