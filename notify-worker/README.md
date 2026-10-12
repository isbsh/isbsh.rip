# isbsh-notify

Cloudflare Worker that polls `https://isbsh.rip/index.xml` every 15 minutes and
announces new posts on Mastodon and Bluesky.

- A post is "new" when its `<guid>` (permalink) hasn't been seen before, so edits
  to published posts don't re-announce. Changing a slug will.
- The first run only records the posts already in the feed; nothing is posted.
- Each platform is tracked separately; a failed platform is retried on later
  runs (up to 5 attempts).
- Unseen items older than 14 days are skipped.

## Setup

```sh
cd notify-worker
npm install
npx wrangler login
npx wrangler kv namespace create STATE   # put the id into wrangler.jsonc
npx wrangler secret put MASTODON_TOKEN
npx wrangler secret put BSKY_APP_PASSWORD
npx wrangler secret put RUN_TOKEN        # optional
npx wrangler deploy
```

- `MASTODON_TOKEN`: Preferences → Development → New application, scope
  `write:statuses` only.
- `BSKY_APP_PASSWORD`: Settings → Privacy and security → App passwords.

## Testing

Set `DRY_RUN` to `"true"` in `wrangler.jsonc` to log instead of posting.

```sh
npm run dev
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

After deploying with `RUN_TOKEN` set, a run can be triggered manually:

```sh
curl -H "Authorization: Bearer <RUN_TOKEN>" https://isbsh-notify.<subdomain>.workers.dev/run
```
