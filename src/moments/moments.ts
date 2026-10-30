import { nanoid } from "nanoid";
import {
  deleteMoment,
  getPurgeableMoments,
  insertMoment,
  markMomentsPurged,
} from "../db/db-ops";
import { moments } from "../db/schema";
import { readImageInfo } from "./image";

type MomentRecord = typeof moments.$inferSelect;

// Structural subset of the Workers R2Bucket binding — keeps us off
// @cloudflare/workers-types for the few calls we make.
export type MomentBucket = {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
};

export type MomentDeps = {
  bucket: MomentBucket;
  // Tells ratne.sh to refresh its cached moments. Must never throw.
  notifySite: () => Promise<void>;
};

// How many moments the portfolio shows; anything beyond this is "rotated off".
export const MOMENTS_ON_HOME = 4;
export const CAPTION_MAX = 140;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_LQIP_CHARS = 6000;

export class MomentError extends Error {}

export function normaliseCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const caption = raw.trim().replace(/\s+/g, " ");
  if (!caption) return null;
  if (caption.length > CAPTION_MAX) {
    throw new MomentError(`caption must be ${CAPTION_MAX} characters or fewer`);
  }
  return caption;
}

function normaliseLqip(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("data:image/") || raw.length > MAX_LQIP_CHARS) return null;
  return raw;
}

type CreateMomentParams = {
  bytes: Uint8Array;
  caption: string | null;
  lqip?: unknown;
  origin: "tg" | "cli" | "web";
  telegramMessageId?: number;
  timestamp?: Date;
};

export async function createMoment(
  deps: MomentDeps,
  params: CreateMomentParams
): Promise<MomentRecord | null> {
  if (params.bytes.length > MAX_BYTES) throw new MomentError("image must be 10MB or smaller");
  const info = readImageInfo(params.bytes);
  if (!info || !info.width || !info.height) {
    throw new MomentError("unsupported image — send a jpeg, png or webp");
  }

  const uid = nanoid(10);
  const r2Key = `moments/${uid}.${info.ext}`;

  // Keys are never reused, so the object can be cached forever.
  await deps.bucket.put(r2Key, params.bytes, {
    httpMetadata: {
      contentType: info.mime,
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  const row = await insertMoment({
    uid,
    r2Key,
    width: info.width,
    height: info.height,
    caption: params.caption,
    lqip: normaliseLqip(params.lqip),
    telegramMessageId: params.telegramMessageId,
    origin: params.origin,
    timestamp: params.timestamp ?? new Date(),
  });

  if (!row) {
    // Duplicate Telegram delivery — drop the object we just wrote.
    await deps.bucket.delete(r2Key);
    return null;
  }

  await deps.notifySite();
  return row;
}

export async function removeMoment(
  deps: MomentDeps,
  uid: string
): Promise<MomentRecord | null> {
  const row = await deleteMoment(uid);
  if (!row) return null;
  await deps.bucket.delete(row.r2Key);
  await deps.notifySite();
  return row;
}

// Deletes R2 objects for moments that rotated off the home page more than
// `retentionDays` ago. Rows stay in Postgres with `purgedAt` set.
export async function purgeMoments(
  deps: MomentDeps,
  retentionDays: number
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const rows = await getPurgeableMoments(MOMENTS_ON_HOME, cutoff);
  if (rows.length === 0) return 0;
  // R2 accepts up to 1000 keys per delete call.
  for (let i = 0; i < rows.length; i += 1000) {
    await deps.bucket.delete(rows.slice(i, i + 1000).map((r) => r.r2Key));
  }
  await markMomentsPurged(rows.map((r) => r.id));
  return rows.length;
}

export function toPublicMoment(row: MomentRecord) {
  return {
    uid: row.uid,
    key: row.r2Key,
    width: row.width,
    height: row.height,
    caption: row.caption,
    lqip: row.lqip,
    origin: row.origin ?? "cli",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
