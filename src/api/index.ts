import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import {
  getAllEditsByUid,
  getAllPostsPaginated,
  getLastPosts,
  getPostByUid,
  getPostTotals,
  insertNewPost,
  restorePost,
  softDeletePostByUid,
  updatePostContentByUid,
} from "../db/db-ops";

const app = new Hono();

// Auth middleware — all routes require a valid Bearer token
app.use("*", async (c, next) => {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken) {
    return c.json({ error: "API_TOKEN is not configured on the server" }, 500);
  }
  const authHeader = c.req.header("Authorization");
  if (!authHeader || authHeader !== `Bearer ${apiToken}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// GET /posts — paginated list (cursor = internal bigserial id)
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

// GET /posts/:uid
app.get("/posts/:uid", async (c) => {
  const uid = c.req.param("uid");
  const post = await getPostByUid(uid);
  if (!post) {
    return c.json({ error: "post not found" }, 404);
  }
  if (post.deleted) {
    return c.json({ error: "post is deleted", deleted: true }, 404);
  }
  return c.json(post);
});

// GET /posts/:uid/edits
app.get("/posts/:uid/edits", async (c) => {
  const uid = c.req.param("uid");
  const edits = await getAllEditsByUid(uid);
  if (edits.length === 0) {
    return c.json({ error: "post not found" }, 404);
  }
  return c.json({ edits });
});

// POST /posts — create a new post (CLI origin)
app.post("/posts", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: "content is required" }, 400);
  }

  const uid = nanoid(10);
  const post = await insertNewPost({
    uid,
    content: body.content.trim(),
    timestamp: new Date(),
    origin: "cli",
  });

  if (!post) {
    return c.json({ error: "failed to insert post" }, 500);
  }

  return c.json(post, 201);
});

// PATCH /posts/:uid — update post content
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

  if (!post) {
    return c.json({ error: "post not found or is deleted" }, 404);
  }

  return c.json(post);
});

// DELETE /posts/:uid — soft delete
app.delete("/posts/:uid", async (c) => {
  const uid = c.req.param("uid");
  const post = await softDeletePostByUid(uid);
  if (!post) {
    return c.json({ error: "post not found" }, 404);
  }
  return c.json(post);
});

// POST /posts/:uid/restore
app.post("/posts/:uid/restore", async (c) => {
  const uid = c.req.param("uid");
  const post = await restorePost(uid);
  if (!post) {
    return c.json({ error: "post not found" }, 404);
  }
  return c.json(post);
});

const port = parseInt(process.env.PORT ?? "3000", 10);

serve({ fetch: app.fetch, port }, () => {
  console.log(`API server running on http://localhost:${port}`);
});
