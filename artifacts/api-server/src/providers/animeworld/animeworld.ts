import * as cheerio from "cheerio";
import { Buffer } from "node:buffer";

// The standalone AnimeWorld addon intentionally uses the .top hostname. It
// currently redirects to .one, and fetch() follows that redirect while
// preserving the site's current URLs. Keep this configurable for future
// hostname changes.
const BASE = (process.env.ANIMEWORLD_BASE_URL || "https://watchanimeworld.top").replace(/\/$/, "");
const TIMEOUT = 20000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function get(url: string, init: RequestInit = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try { return await fetch(url, { ...init, signal: c.signal, headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", ...(init.headers || {}) } }); }
  finally { clearTimeout(t); }
}

function abs(u: string, base = BASE) { try { return new URL(u, base).toString(); } catch { return u; } }
function norm(s: string) { return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim(); }
function compact(s: string) { return norm(s).replace(/\s+/g, ""); }
function score(a: string, b: string) {
  // AnimeWorld uses both "Shinchan" and "Shin Chan" in different places.
  // Match collapsed spellings before applying the token-overlap score.
  if (compact(a) === compact(b) && compact(a)) return 1;
  const x = new Set(norm(a).split(" ").filter(Boolean)); const y = new Set(norm(b).split(" ").filter(Boolean));
  if (!x.size || !y.size) return 0;
  let hit = 0; for (const v of x) if (y.has(v)) hit++;
  return (2 * hit) / (x.size + y.size);
}

export interface AnimeWorldStream { name: string; title: string; url: string; behaviorHints?: Record<string, unknown>; _resolvedTitle?: string; }

function searchVariants(title: string, extra: string[] = []) {
  const beforeColon = title.split(":")[0]!.trim();
  const hyphenToSpace = title.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  const collapsed = title.replace(/[-\s]+/g, "").trim();
  return [...new Set([title, beforeColon, hyphenToSpace, collapsed, ...extra])]
    .map((v) => v.trim())
    .filter((v) => v.length > 2);
}

export async function findAnimeWorldSlug(
  title: string,
  type: "movie" | "series",
  extraQueries: string[] = [],
): Promise<{ slug: string; title: string } | null> {
  const all = new Map<string, { slug: string; title: string; type: "movie" | "series" }>();

  for (const query of searchVariants(title, extraQueries)) {
    try {
      const r = await get(`${BASE}/?s=${encodeURIComponent(query)}`);
      if (!r.ok) continue;
      const html = await r.text();
      const $ = cheerio.load(html);
      const items = $("#aa-movies ul.post-lst > li").length
        ? $("#aa-movies ul.post-lst > li")
        : $("article");

      items.each((_, el) => {
        const a = $(el).find("a.lnk-blk").first();
        const h = $(el).find("h2.entry-title, h1.entry-title").first();
        const href = a.attr("href");
        const name = h.text().trim();
        if (!href || !name) return;

        const absolute = abs(href);
        let parsed: URL;
        try { parsed = new URL(absolute); } catch { return; }
        const slug = parsed.pathname.replace(/\/+$/, "").split("/").pop() || "";
        if (!slug) return;
        const itemType = parsed.pathname.includes("/movies/") ? "movie" : "series";
        all.set(`${itemType}:${slug}`, { slug, title: name, type: itemType });
      });
    } catch {
      // Try the next spelling variant; the standalone addon also treats an
      // unavailable search request as an empty result.
    }
  }

  const typed = [...all.values()].filter((candidate) => candidate.type === type);
  const pool = typed.length ? typed : [...all.values()];
  pool.sort((a, b) => score(b.title, title) - score(a.title, title));
  const best = pool[0];
  return best && score(best.title, title) >= 0.45
    ? { slug: best.slug, title: best.title }
    : null;
}

async function episodePage(slug: string, type: "movie" | "series", season?: number, episode?: number) {
  if (type === "movie") return `${BASE}/movies/${slug}`;
  return `${BASE}/episode/${slug}-${season || 1}x${episode || 1}/`;
}

async function abyssPlayerIsUsable(playerUrl: string): Promise<boolean> {
  const candidates = new Set<string>([playerUrl]);
  try {
    const encoded = new URL(playerUrl).searchParams.get("data");
    if (encoded) {
      const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
      const entries = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (entry && typeof entry.link === "string") candidates.add(entry.link);
        }
      }
    }
  } catch {}

  const probes = [...candidates].map(async (candidate) => {
    try {
      const response = await get(candidate, { headers: { Referer: playerUrl } });
      if (!response.ok) return false;
      const html = await response.text();
      return /const\s+datas\s*=\s*"[^"]+"/.test(html);
    } catch {
      return false;
    }
  });
  return (await Promise.all(probes)).some(Boolean);
}

async function iframeStreams(pageUrl: string, proxyBase: string): Promise<AnimeWorldStream[]> {
  const r = await get(pageUrl); if (!r.ok) return [];
  const html = await r.text(); const $ = cheerio.load(html); const out: AnimeWorldStream[] = []; const seen = new Set<string>();
  for (const el of $("iframe").toArray()) {
    // Some pages use a lazy-loading placeholder in src and put the actual
    // player in data-src. Do not let about:blank or javascript: hide it.
    const src = ($(el).attr("src") || "").trim();
    const lazy = ($(el).attr("data-src") || "").trim();
    const raw = src && !/^(about:blank|javascript:)/i.test(src) ? src : lazy;
    if (!raw) continue;
    const u = abs(raw.replace(/&amp;/g, "&"), pageUrl);
    const low = u.toLowerCase();
    const player = /zephyr/i.test(low)
      ? "zephyr"
      : /player1\.php|abyssplayer|abysscdn|short\.icu/i.test(low)
        ? "abyss"
        : null;
    if (!player) continue;

    const key = `${player}:${u}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (player === "zephyr") {
      out.push({
        name: "AnimeWorld",
        title: "AnimeWorld · ZephyrFlick",
        url: `${proxyBase}/animeworld/resolve?url=${encodeURIComponent(u)}`,
        behaviorHints: { notWebReady: true },
      });
    } else {
      // The standalone addon only emits Abyss streams after the player1
      // short links reach a real player page. Do the same here so Stremio
      // never displays a resolver URL that is guaranteed to return 404.
      if (!(await abyssPlayerIsUsable(u))) continue;
      out.push({
        name: "AnimeWorld",
        title: "AnimeWorld · Abyss",
        url: `${proxyBase}/animeworld/abyss?url=${encodeURIComponent(u)}`,
        behaviorHints: { notWebReady: true },
      });
    }
  }
  return out;
}

export async function getStreams(
  title: string,
  type: "movie" | "series",
  season = 1,
  episode = 1,
  proxyBase: string,
  aliases: string[] = [],
): Promise<AnimeWorldStream[]> {
  try {
    const match = await findAnimeWorldSlug(title, type, aliases);
    if (!match) return [];
    const page = await episodePage(match.slug, type, season, episode);
    const streams = await iframeStreams(page, proxyBase);
    return streams.map(s => ({ ...s, _resolvedTitle: match.title }));
  } catch { return []; }
}
