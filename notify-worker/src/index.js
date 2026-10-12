// Polls the blog RSS feed and announces new posts on Mastodon and Bluesky.
//
// State lives in KV:
//   "initialized"   -> set after the first run (which only records existing posts)
//   "post:<guid>"   -> JSON { mastodon: bool, bluesky: bool, attempts: number }

const PLATFORMS = ["mastodon", "bluesky"];
const MAX_ATTEMPTS = 5;
const MAX_AGE_DAYS = 14;
const BSKY_MAX_BLOB_BYTES = 976 * 1024;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  // Manual trigger: GET /run with "Authorization: Bearer <RUN_TOKEN>"
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run" || !env.RUN_TOKEN) {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("Authorization") !== `Bearer ${env.RUN_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const log = await run(env);
    return Response.json(log);
  },
};

async function run(env) {
  const log = [];
  const items = await fetchFeed(env.FEED_URL);
  const initialized = await env.STATE.get("initialized");

  // First run: mark everything currently in the feed as already posted so we
  // don't flood timelines with old entries.
  if (!initialized) {
    for (const item of items) {
      await env.STATE.put(
        stateKey(item.guid),
        JSON.stringify({ mastodon: true, bluesky: true, attempts: 0 }),
      );
    }
    await env.STATE.put("initialized", new Date().toISOString());
    log.push(`initialized with ${items.length} existing items`);
    console.log(log.at(-1));
    return log;
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  // Oldest first so multiple new posts are announced in publication order.
  for (const item of [...items].reverse()) {
    const raw = await env.STATE.get(stateKey(item.guid));
    const state = raw
      ? JSON.parse(raw)
      : { mastodon: false, bluesky: false, attempts: 0 };

    const pending = PLATFORMS.filter((p) => !state[p]);
    if (pending.length === 0) continue;

    if (!raw && item.pubDate && item.pubDate.getTime() < cutoff) {
      // Old item that was never seen (e.g. KV was reset); don't announce it.
      await env.STATE.put(
        stateKey(item.guid),
        JSON.stringify({ mastodon: true, bluesky: true, attempts: 0 }),
      );
      log.push(`skipped old item: ${item.link}`);
      continue;
    }

    if (state.attempts >= MAX_ATTEMPTS) continue;
    state.attempts += 1;

    for (const platform of pending) {
      try {
        if (env.DRY_RUN === "true") {
          log.push(`[dry-run] ${platform}: ${buildText(env, item)}`);
          continue;
        }
        if (platform === "mastodon") await postToMastodon(env, item);
        if (platform === "bluesky") await postToBluesky(env, item);
        state[platform] = true;
        log.push(`${platform}: posted ${item.link}`);
      } catch (err) {
        log.push(`${platform}: failed ${item.link} (attempt ${state.attempts}): ${err.message}`);
      }
      console.log(log.at(-1));
    }

    if (env.DRY_RUN !== "true") {
      await env.STATE.put(stateKey(item.guid), JSON.stringify(state));
    }
  }

  return log;
}

function stateKey(guid) {
  return `post:${guid}`;
}

// ---------------------------------------------------------------------------
// RSS

async function fetchFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "isbsh-notify-worker" },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`feed fetch failed: ${res.status}`);
  const xml = await res.text();

  const items = [];
  for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = decodeEntities(tag(body, "title"));
    const link = decodeEntities(tag(body, "link"));
    const guid = decodeEntities(tag(body, "guid")) || link;
    const pubDateRaw = tag(body, "pubDate");
    const description = decodeEntities(tag(body, "description"));
    if (!link) continue;
    items.push({
      title,
      link,
      guid,
      pubDate: pubDateRaw ? new Date(pubDateRaw) : null,
      image: firstImage(description),
      summary: summarize(description),
    });
  }
  return items;
}

function tag(body, name) {
  const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function firstImage(html) {
  const m = html.match(/<img[^>]+src="([^"]+)"/);
  return m ? m[1] : null;
}

function summarize(html, max = 140) {
  const text = decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildText(env, item) {
  const template = env.POST_TEMPLATE || "ブログを更新しました: {title}\n{url}";
  return template.replaceAll("{title}", item.title).replaceAll("{url}", item.link);
}

// ---------------------------------------------------------------------------
// Mastodon

async function postToMastodon(env, item) {
  const res = await fetch(`${env.MASTODON_INSTANCE}/api/v1/statuses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MASTODON_TOKEN}`,
      "Content-Type": "application/json",
      // Prevents duplicate toots if a retry happens after a successful post.
      "Idempotency-Key": item.guid,
    },
    body: JSON.stringify({
      status: buildText(env, item),
      visibility: env.MASTODON_VISIBILITY || "public",
    }),
  });
  if (!res.ok) {
    throw new Error(`mastodon ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Bluesky

async function postToBluesky(env, item) {
  const service = env.BSKY_SERVICE || "https://bsky.social";

  const sessionRes = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: env.BSKY_IDENTIFIER,
      password: env.BSKY_APP_PASSWORD,
    }),
  });
  if (!sessionRes.ok) {
    throw new Error(`bluesky login ${sessionRes.status}: ${await sessionRes.text()}`);
  }
  const session = await sessionRes.json();
  const auth = { Authorization: `Bearer ${session.accessJwt}` };

  const text = buildText(env, item);
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    langs: ["ja"],
    facets: linkFacets(text),
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: item.link,
        title: item.title,
        description: item.summary,
      },
    },
  };

  const thumb = await uploadThumb(service, auth, item.image);
  if (thumb) record.embed.external.thumb = thumb;

  const res = await fetch(`${service}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });
  if (!res.ok) {
    throw new Error(`bluesky post ${res.status}: ${await res.text()}`);
  }
}

// Bluesky doesn't auto-link URLs; facets need UTF-8 byte offsets.
function linkFacets(text) {
  const encoder = new TextEncoder();
  const facets = [];
  for (const m of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const byteStart = encoder.encode(text.slice(0, m.index)).length;
    const byteEnd = byteStart + encoder.encode(m[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    });
  }
  return facets;
}

// Thumbnail is best-effort: any failure just posts the card without an image.
async function uploadThumb(service, auth, imageUrl) {
  if (!imageUrl) return null;
  try {
    // Cloudinary's f_auto negotiates by Accept; ask for JPEG to stay compatible.
    const img = await fetch(imageUrl, { headers: { Accept: "image/jpeg" } });
    if (!img.ok) return null;
    const bytes = await img.arrayBuffer();
    if (bytes.byteLength > BSKY_MAX_BLOB_BYTES) return null;

    const res = await fetch(`${service}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": img.headers.get("Content-Type") || "image/jpeg",
      },
      body: bytes,
    });
    if (!res.ok) return null;
    return (await res.json()).blob;
  } catch {
    return null;
  }
}
