# nowa

The backend behind [ratne.sh](https://www.ratne.sh). It stores two things:

- **Posts:** short thoughts, shown on `/now`.
- **Moments:** photos, shown on the home page (newest 4) and `/moments`.

You can post from the terminal or Telegram, and both end up in the same database:

| From | Thoughts | Photos |
|---|---|---|
| Terminal | `nowa <text>` | `nowa snap <image> [caption]` |
| Telegram | send a message | send a photo |

## How it fits together

```
nowa CLI ─────┐
              ├──> Cloudflare Worker (api.ratne.sh) ──> Neon Postgres (text, metadata)
Telegram bot ─┘             │                       ──> R2 bucket "moments" (images)
                            │                              served at mom.ratne.sh
                            └──> tells ratne.sh to refresh when moments change
```

Built with Hono, Drizzle ORM and Telegraf. The Worker is named `nowu` in `wrangler.toml`.

## CLI

### Setup

Needs Node 22.6 or newer. Run this once:

```bash
chmod +x cli/nowa.ts
ln -sf "$(pwd)/cli/nowa.ts" ~/.local/bin/nowa
export NOWA_SECRET="<same value as the Worker's API_TOKEN>"   # put this in ~/.bashrc
```

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NOWA_SECRET` | yes | | Bearer token for the API |
| `NOWA_API_URL` | no | `https://api.ratne.sh` | API base URL |

### Posts

| Command | What it does |
|---|---|
| `nowa <text...>` | Create a post |
| `nowa last [n]` | Show the last `n` posts (default 1, max 10) |
| `nowa ls [n]` | List the last `n` posts (default 10, max 100) |
| `nowa get <uid>` | Show one post |
| `nowa edit <uid> <text...>` | Change a post (the old text is kept in its history) |
| `nowa edits <uid>` | Show a post's edit history |
| `nowa delete <uid>` | Soft-delete a post |
| `nowa restore <uid>` | Bring a deleted post back |
| `nowa trash [n]` | Show the last `n` deleted posts (default 5) |
| `nowa stats` | Show total, visible and deleted counts |
| `nowa -h`, `nowa --help` | Show help |

Quote text that has shell characters such as `'`, `&` or `?`:

```bash
nowa back at chaayos again
nowa "what's cooking? shipping tonight"
nowa edit abc123 updated content here
```

Text whose first word is a command name (for example `last`) runs that command. Posts have no separate "new" command, so reword it if that happens.

### Moments

| Command | What it does |
|---|---|
| `nowa snap <image> [caption...]` | Post a photo |
| `nowa moments` | List the 4 newest moments, with their uids |
| `nowa unsnap <uid>` | Delete a moment and its image. This can't be undone. |

```bash
nowa snap ~/Pictures/photo.jpg chai and a sunset
```

- Images must be JPEG, PNG or WebP, up to 10MB. HEIC is not supported.
- Captions are optional, up to 140 characters.
- The CLI uploads the file as it is, with no resizing and no blur placeholder. For large phone photos, use Telegram.

`cli/nowu.ts` is an older copy of this CLI with its own variables and a different default API. Use `nowa`.

## Telegram bot

Only usernames listed in `ALLOWED_USERNAMES` can use the bot.

| Send this | What it does |
|---|---|
| A text message | Create a post |
| A photo, with an optional caption | Create a moment |
| Reply to your own post, or to a `/last` result, with text | Edit that post |
| Reply to a photo, or to its `moment posted` confirmation, with text | Change the moment's caption |
| `/delete` as a reply, or `/delete <uid>` | Delete a post or moment |
| `/which <uid>` | Show a post |
| `/last [n]` | Show the last `n` posts (max 10) |
| `/trash [n]` | Show the last `n` deleted posts (max 10) |
| `/restore <uid>` | Bring a deleted post back |
| `/stats` | Show post counts |

Send photos as a photo, not as a file. Files are rejected.

## API

Every route needs `Authorization: Bearer <API_TOKEN>`, except `/webhook`, which checks Telegram's secret token header instead.

### Posts

| Route | Body or query | Notes |
|---|---|---|
| `GET /posts` | `?limit=&cursor=` | Paginated, default 20, max 100 |
| `GET /posts/stats` | | Total, visible and deleted counts |
| `GET /posts/last` | `?n=` | Default 1, max 10 |
| `GET /posts/trash` | `?limit=&cursor=` | Deleted posts, paginated |
| `GET /posts/:uid` | | One post |
| `GET /posts/:uid/edits` | | Edit history |
| `POST /posts` | `{ content, origin? }` | `origin` is `tg`, `cli` or `web`; default `cli` |
| `PATCH /posts/:uid` | `{ content }` | Keeps the old text in history |
| `DELETE /posts/:uid` | | Soft delete |
| `POST /posts/:uid/restore` | | Undo a delete |

### Moments

| Route | Body or query | Notes |
|---|---|---|
| `GET /moments` | `?n=` | Newest first, default 4, max 200 |
| `POST /moments` | Multipart: `file`, `caption?`, `lqip?`, `origin?` | `lqip` is a small `data:image/...` blur placeholder |
| `PATCH /moments/:uid` | `{ caption }` | An empty string clears the caption |
| `DELETE /moments/:uid` | | Also removes the image from R2 straight away |

### Telegram

| Route | Notes |
|---|---|
| `POST /webhook` | Receives Telegram updates |

## How moments rotate and get cleaned up

1. The home page shows the 4 newest moments. Posting a new one pushes the oldest off.
2. A rotated-off moment stays on `/moments`.
3. A daily job at 03:00 IST deletes the image from R2 once the moment is off the home page and older than `MOMENTS_RETENTION_DAYS` (default 30). It then disappears from `/moments`, while its database row stays.

To keep photos longer, raise `MOMENTS_RETENTION_DAYS` in `wrangler.toml` and redeploy.

After a delete, Cloudflare's edge cache can keep serving the old image URL for a while, even though the site no longer links to it.

## Configuration

### Worker secrets

Set each one with `npx wrangler secret put <NAME>`:

| Secret | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `API_TOKEN` | Bearer token for the API. Must match `TELEGRAM_SECRET` on ratne.sh and `NOWA_SECRET` in your shell. |
| `BOT_TOKEN` | Telegram bot token from BotFather |
| `ALLOWED_USERNAMES` | Comma-separated Telegram usernames |
| `WEBHOOK_SECRET` | Secret token Telegram sends with each webhook call |

### `wrangler.toml`

| Setting | Value | Purpose |
|---|---|---|
| `MOMENTS` | R2 bucket `moments` | Image storage |
| `SITE_URL` | `https://www.ratne.sh` | Site to refresh when moments change. Use the `www` address: `ratne.sh` redirects to it. |
| `MOMENTS_RETENTION_DAYS` | `30` | See the cleanup section above |
| `crons` | `30 21 * * *` | The daily cleanup, 03:00 IST |

### Cloudflare dashboard

- **R2:** bucket `moments` with the custom domain `mom.ratne.sh`.
- **Images:** Transformations enabled for `ratne.sh`. This resizes photos and serves AVIF or WebP. If it's off, the site falls back to full-size originals, which load slower.

### Local `.env`

Copy `.env.sample` to `.env`. Local scripts need it; the deployed Worker doesn't read it.

## Development

```bash
pnpm install
```

| Command | What it does |
|---|---|
| `pnpm worker:dev` | Run the Worker locally |
| `pnpm api` | Run the local Node API. It has post routes only, no moments. |
| `pnpm bot` | Run the bot with long polling. Photos won't work here. |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm db:generate` | Generate a migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations listed in drizzle's journal |
| `pnpm health:prod` | Check production, including the Telegram webhook. Needs `.env`. |

## Deploy

Pushing to GitHub doesn't deploy anything. Deploy by hand:

```bash
git push origin HEAD
pnpm worker:deploy
```

### Database migrations

Migrations `0006` and `0007` aren't in drizzle's journal, so `pnpm db:migrate` skips them. Apply those with `psql`:

```bash
psql "<neon-connection-string>" -f drizzle/0007_add_moments.sql
```

### If the bot stops replying

A deploy can leave the Telegram webhook unset. Register it again:

```bash
curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://api.ratne.sh/webhook\",\"secret_token\":\"$WEBHOOK_SECRET\"}"
```

`npx wrangler tail` shows live Worker logs. Known problems and their fixes are in [ISSUES.md](./ISSUES.md).

## Project layout

```
cli/nowa.ts          the CLI
cli/nowu.ts          older copy of the CLI
src/worker.ts        Cloudflare Worker: all routes and the daily cleanup
src/bot/bot-core.ts  Telegram bot
src/moments/         image checks, R2 storage, cleanup logic
src/db/              Drizzle schema and queries
src/api/index.ts     local Node API (posts only)
src/services/        health check and one-off maintenance scripts
drizzle/             SQL migrations
```
