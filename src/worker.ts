import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createBot } from "./bot/bot-core";
import {
  getAllEditsByUid,
  getAllPostsPaginated,
  getDeletedPostsPaginated,
  getLastPosts,
  getLatestMoments,
  getMomentByUid,
  getPostByUid,
  getPostTotals,
  initDb,
  insertNewPost,
  restorePost,
  softDeletePostByUid,
  updateMomentCaption,
  updatePostContentByUid,
} from "./db/db-ops";
import {
  MomentBucket,
  MomentDeps,
  MomentError,
  createMoment,
  normaliseCaption,
  purgeMoments,
  removeMoment,
  toPublicMoment,
} from "./moments/moments";

type Env = {
  DATABASE_URL: string;
  API_TOKEN: string;
  BOT_TOKEN: string;
  ALLOWED_USERNAMES: string;
  WEBHOOK_SECRET: string;
  MOMENTS: MomentBucket;
  SITE_URL?: string;
  MOMENTS_RETENTION_DAYS?: string;
};

function momentDeps(env: Env): MomentDeps {
  return {
    bucket: env.MOMENTS,
    notifySite: async () => {
      if (!env.SITE_URL) return;
      try {
        // ratne.sh shares API_TOKEN with this worker (as TELEGRAM_SECRET there).
        await fetch(`${env.SITE_URL}/api/revalidate`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tag: "moments" }),
        });
        // Re-render the home page now so no visitor pays for the cache miss.
        await fetch(env.SITE_URL, { headers: { "User-Agent": "nowa-warmup" } });
      } catch (error) {
        console.error("Failed to notify site of moment change:", error);
      }
    },
  };
}

const app = new Hono<{ Bindings: Env }>();

// Initialize DB singleton on first request using the CF env binding.
// initDb() is idempotent — subsequent calls return immediately.
app.use("*", async (c, next) => {
  initDb(c.env.DATABASE_URL);
  await next();
});

// Auth middleware — /webhook is verified separately via secret token header.
app.use("*", async (c, next) => {
  if (c.req.path === "/webhook") return next();
  const apiToken = c.env.API_TOKEN;
  if (!apiToken) {
    return c.json({ error: "API_TOKEN is not configured on the server" }, 500);
  }
  const authHeader = c.req.header("Authorization");
  if (!authHeader || authHeader !== `Bearer ${apiToken}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// POST /webhook — receives Telegram updates
app.post("/webhook", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!secret || secret !== c.env.WEBHOOK_SECRET) {
    return c.json({ error: "forbidden" }, 403);
  }
  const bot = createBot(c.env.BOT_TOKEN, c.env.ALLOWED_USERNAMES, momentDeps(c.env));
  const update = await c.req.json();
  await bot.handleUpdate(update);
  return c.json({ ok: true });
});

// GET /posts
app.get("/posts", async (c) => {
  const limitParam = c.req.query("limit");
  const cursorParam = c.req.query("cursor");
  const limit = Math.min(Math.max(1, parseInt(limitParam ?? "20", 10)), 100);
  const cursor = cursorParam ? parseInt(cursorParam, 10) : undefined;
  const result = await getAllPostsPaginated(limit, cursor);
  return c.json(result);
});

// GET /posts/stats — must be before /posts/:uid
app.get("/posts/stats", async (c) => {
  const totals = await getPostTotals();
  return c.json(totals);
});

// GET /posts/last — must be before /posts/:uid
app.get("/posts/last", async (c) => {
  const nParam = c.req.query("n");
  const n = Math.min(Math.max(1, parseInt(nParam ?? "1", 10)), 10);
  const posts = await getLastPosts(n);
  return c.json({ posts });
});

// GET /posts/trash — paginated list of deleted posts; must be before /posts/:uid
app.get("/posts/trash", async (c) => {
  const limitParam = c.req.query("limit");
  const cursorParam = c.req.query("cursor");
  const limit = Math.min(Math.max(1, parseInt(limitParam ?? "20", 10)), 100);
  const cursor = cursorParam ? parseInt(cursorParam, 10) : undefined;
  const result = await getDeletedPostsPaginated(limit, cursor);
  return c.json(result);
});

// GET /posts/:uid
app.get("/posts/:uid", async (c) => {
  const uid = c.req.param("uid");
  const post = await getPostByUid(uid);
  if (!post) return c.json({ error: "post not found" }, 404);
  if (post.deleted) return c.json({ error: "post is deleted", deleted: true }, 404);
  return c.json(post);
});

// GET /posts/:uid/edits
app.get("/posts/:uid/edits", async (c) => {
  const uid = c.req.param("uid");
  const edits = await getAllEditsByUid(uid);
  if (edits.length === 0) return c.json({ error: "post not found" }, 404);
  return c.json({ edits });
});

// POST /posts
app.post("/posts", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: "content is required" }, 400);
  }
  const allowedOrigins = ["tg", "cli", "web"] as const;
  const origin = allowedOrigins.includes(body.origin) ? body.origin : "cli";
  const uid = nanoid(10);
  const post = await insertNewPost({
    uid,
    content: body.content.trim(),
    timestamp: new Date(),
    origin,
  });
  if (!post) return c.json({ error: "failed to insert post" }, 500);
  return c.json(post, 201);
});

// PATCH /posts/:uid
app.patch("/posts/:uid", async (c) => {
  const uid = c.req.param("uid");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: "content is required" }, 400);
  }
  const post = await updatePostContentByUid({
    uid,
    newContent: body.content.trim(),
    editedAt: new Date(),
  });
  if (!post) return c.json({ error: "post not found or is deleted" }, 404);
  return c.json(post);
});

// DELETE /posts/:uid
app.delete("/posts/:uid", async (c) => {
  const uid = c.req.param("uid");
  const post = await softDeletePostByUid(uid);
  if (!post) return c.json({ error: "post not found" }, 404);
  return c.json(post);
});

// POST /posts/:uid/restore
app.post("/posts/:uid/restore", async (c) => {
  const uid = c.req.param("uid");
  const post = await restorePost(uid);
  if (!post) return c.json({ error: "post not found" }, 404);
  return c.json(post);
});

// GET /moments — newest visible moments for the portfolio home page
app.get("/moments", async (c) => {
  const n = parseInt(c.req.query("n") ?? "4", 10) || 4;
  const rows = await getLatestMoments(n);
  return c.json({ moments: rows.map(toPublicMoment) });
});

// POST /moments — multipart: file, caption?, lqip?, origin?
app.post("/moments", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !file || typeof file === "string") {
    return c.json({ error: "file is required" }, 400);
  }
  const allowedOrigins = ["tg", "cli", "web"] as const;
  const originField = form.get("origin");
  const origin = allowedOrigins.find((o) => o === originField) ?? "cli";
  try {
    const row = await createMoment(momentDeps(c.env), {
      bytes: new Uint8Array(await file.arrayBuffer()),
      caption: normaliseCaption(form.get("caption")),
      lqip: form.get("lqip"),
      origin,
    });
    if (!row) return c.json({ error: "failed to insert moment" }, 500);
    return c.json(toPublicMoment(row), 201);
  } catch (error) {
    if (error instanceof MomentError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

// PATCH /moments/:uid — { caption } (empty string clears it)
app.patch("/moments/:uid", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !("caption" in body)) return c.json({ error: "caption is required" }, 400);
  try {
    const row = await updateMomentCaption(c.req.param("uid"), normaliseCaption(body.caption));
    if (!row) return c.json({ error: "moment not found" }, 404);
    c.executionCtx.waitUntil(momentDeps(c.env).notifySite());
    return c.json(toPublicMoment(row));
  } catch (error) {
    if (error instanceof MomentError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

// DELETE /moments/:uid — removes the R2 object immediately
app.delete("/moments/:uid", async (c) => {
  const uid = c.req.param("uid");
  const existing = await getMomentByUid(uid);
  if (!existing || existing.deleted) return c.json({ error: "moment not found" }, 404);
  await removeMoment(momentDeps(c.env), uid);
  return c.json({ uid, deleted: true });
});

type ScheduledEvent = { cron: string; scheduledTime: number };
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export default {
  fetch: app.fetch,
  // Daily cron (see wrangler.toml): frees R2 space for rotated-off moments.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    initDb(env.DATABASE_URL);
    const days = parseInt(env.MOMENTS_RETENTION_DAYS ?? "30", 10) || 30;
    ctx.waitUntil(
      purgeMoments(momentDeps(env), days).then((n) =>
        console.log(`moments purge: removed ${n} object(s) older than ${days}d`)
      )
    );
  },
};
