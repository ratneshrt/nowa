import {
  bigserial,
  bigint,
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const originEnum = pgEnum("origin_type", ["tg", "cli", "web"]);

export const posts = pgTable("posts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  uid: text("uid").notNull().unique(),
  telegramMessageId: bigint("telegram_message_id", { mode: "number" }).unique(),
  authorTelegramId: bigint("author_telegram_id", { mode: "number" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  editCount: integer("edit_count").notNull().default(0),
  deleted: boolean("deleted").notNull().default(false),
  origin: originEnum("origin"),
});

export const postVersions = pgTable(
  "post_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    postId: bigint("post_id", { mode: "number" })
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    editNumber: integer("edit_number").notNull(),
    contentSnapshot: text("content_snapshot").notNull(),
    editedBy: bigint("edited_by", { mode: "number" }),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull(),
    origin: originEnum("origin"),
  },
  (table) => ({
    editSequenceIdx: uniqueIndex("post_versions_post_id_edit_number_idx").on(
      table.postId,
      table.editNumber
    ),
  })
);

export const postsRelations = relations(posts, ({ many }) => ({
  versions: many(postVersions),
}));

export const postVersionsRelations = relations(postVersions, ({ one }) => ({
  post: one(posts, {
    fields: [postVersions.postId],
    references: [posts.id],
  }),
}));

// Photo "moments" shown on the portfolio home page. The image itself lives in
// R2 under `r2Key`; `purgedAt` is set once that object has been removed by the
// retention cron (the row is kept so history/timestamps survive).
export const moments = pgTable("moments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  uid: text("uid").notNull().unique(),
  r2Key: text("r2_key").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  caption: text("caption"),
  lqip: text("lqip"),
  telegramMessageId: bigint("telegram_message_id", { mode: "number" }).unique(),
  origin: originEnum("origin"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  deleted: boolean("deleted").notNull().default(false),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
});
