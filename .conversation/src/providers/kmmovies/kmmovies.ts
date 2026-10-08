import * as cheerio from "cheerio";

// KMMovies moved its primary site from .rest/.pics to .baby. Keep the old
// hostnames accepted for older post links, but search against the live domain.
export const KMMOVIES_BASE = (process.env.KMMOVIES_BASE || "https://kmmovies.baby").replace(/\/+$/, "");
const KMMOVIES_HOSTS = new Set(["kmmovies.baby", "kmmovies.rest", "kmmovies.pics"]);
const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface KMMoviesStream {
  name: string;
  title: string;
  url: string;
  /** Internal source page used to refresh short-lived signed URLs at playback time. */
  refreshUrl?: string;
  quality?: string;
  size?: string;
  audio?: string;
  behaviorHints?: {
    proxyHeaders?: {
      request?: Record<string, string>;
    };
    notWebReady?: boolean;
  };
}

function formatKMMoviesServerName(hostName: string): string {
  const normalized = hostName.toLowerCase();
  if (normalized.includes("pixeldrain")) return "Pixeldrain";
  if (normalized.includes("skydrop")) return "SkyDrop";
  if (normalized.includes("r2")) return "R2 Cloud";
  if (normalized.includes("fast cloud")) return "Fast Server";
  return hostName;
}

interface PostMatch {
  title: string;
  url: string;
  year?: number;
  quality?: string;
}

interface QualityLink {
  quality: string;
  size?: string;
  url: string;
  isEpisodePage?: boolean;
}

function isKMMoviesPageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && KMMOVIES_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

const PLAYABLE_HOSTS = new Set([
  "z1.kmphotos.cv",
  "pixeldrain.com",
  "cdn.pixeldrain.com",
  "charlie.freakingfileditch.st",
]);

export function isAllowedMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      (PLAYABLE_HOSTS.has(parsed.hostname) ||
        parsed.hostname.endsWith(".r2.dev") ||
        parsed.hostname.endsWith(".skydrop.sbs") ||
        parsed.hostname.endsWith(".skydrop.cv"))
    );
  } catch {
    return false;
  }
}

export async function isPlayableVideoUrl(url: string): Promise<boolean> {
  if (!isAllowedMediaUrl(url)) return false;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...DEFAULT_HEADERS,
        Range: "bytes=0-1023",
        Referer: KMMOVIES_BASE + "/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok && response.status !== 206) return false;

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const contentRange = response.headers.get("content-range") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    const isMatroska = bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    const looksLikeVideo =
      contentType.startsWith("video/") ||
      contentType.includes("octet-stream") ||
      isMatroska;

    return looksLikeVideo && (contentRange.includes("bytes") || bytes.length > 0);
  } catch {
    return false;
  }
}

export async function resolveDownloadPage(downloadUrl: string): Promise<string[]> {
  // ZIP-ZAP now redirects directly to a short-lived signed media URL. Follow
  // that redirect manually first so we never download an entire video while
  // trying to inspect it as HTML.
  try {
    const redirectResponse = await fetch(downloadUrl, {
      method: "GET",
      headers: {
        ...DEFAULT_HEADERS,
        Referer: KMMOVIES_BASE + "/",
        Range: "bytes=0-0",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
    });
    const location = redirectResponse.headers.get("location");
    if (location) {
      const resolved = new URL(location, downloadUrl).toString();
      const resolvedUrl = new URL(resolved);
      const contentType = (redirectResponse.headers.get("content-type") || "").toLowerCase();
      if (
        isAllowedMediaUrl(resolved) &&
        (resolvedUrl.searchParams.has("dl") ||
          contentType.startsWith("video/") ||
          contentType.includes("octet-stream"))
      ) {
        return [resolved];
      }
    }
  } catch {}

  // Prefer the landing page: ZIP-ZAP may first redirect to an HTML page that
  // contains short-lived R2/Worker download buttons.
  const html = await fetchHtmlSafe(downloadUrl, KMMOVIES_BASE + "/");
  if (html) {
    const $ = cheerio.load(html);
    const links: string[] = [];
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href")?.replace(/&amp;/g, "&");
      if (!href || !/[?&]dl=(?:r2|worker)\b/.test(href)) return;
      try {
        const absolute = new URL(href, downloadUrl).toString();
        if (!links.includes(absolute)) links.push(absolute);
      } catch {}
    });
    if (links.length > 0) return links;
  }

  return [];
}

async function fetchHtmlSafe(url: string, referer?: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        ...(referer ? { Referer: referer } : {}),
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err: any) {
    return null;
  }
}

async function resolveOnlineMediaUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...DEFAULT_HEADERS,
        Referer: KMMOVIES_BASE + "/",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
    });
    const location = response.headers.get("location");
    if (!location) return null;
    const redirected = new URL(location, url);
    const videoUrl = redirected.searchParams.get("videoUrl");
    return videoUrl && isAllowedMediaUrl(videoUrl) ? videoUrl : null;
  } catch {
    return null;
  }
}

export async function searchKMMovies(query: string): Promise<PostMatch[]> {
  const cleanQuery = query.replace(/[^\w\s]/g, " ").trim();
  const searchUrl = `${KMMOVIES_BASE}/?s=${encodeURIComponent(cleanQuery)}`;
  const html = await fetchHtmlSafe(searchUrl);
  if (!html) return [];

  const $ = cheerio.load(html);
  const posts: PostMatch[] = [];

  // Prefer actual result cards. Scanning every anchor also picked the new
  // theme's logo/home link as the first "result", which made resolution stop
  // before it ever reached a movie page.
  let resultElements = $("article, .post, .thumb, .entry-title a, .post-title a, h2 a, h3 a");
  if (resultElements.length === 0) resultElements = $("a[href]");

  resultElements.each((_, el) => {
    const a = $(el).is("a") ? $(el) : $(el).find("a").first();
    const rawTitle = (a.text() || $(el).text() || "").trim().replace(/\s+/g, " ");
    const href = a.attr("href");

    if (
      href &&
      isKMMoviesPageUrl(href) &&
      new URL(href).pathname !== "/" &&
      !href.includes("/category/") &&
      !href.includes("/tag/") &&
      !href.includes("/page/") &&
      !href.includes("/genre/") &&
      !href.includes("/trending/") &&
      !href.includes("/browse/") &&
      !href.includes("/actor/") &&
      !href.includes("/director/") &&
      !href.includes("/writer/") &&
      !href.includes("/year/") &&
      !href.includes("/disclaimer/") &&
      !href.includes("/privacy-policy/") &&
      !href.includes("/dmca/") &&
      !href.includes("/faq/") &&
      href !== "https://kmmovies.rest/" &&
      href !== "https://kmmovies.rest" &&
      href !== "https://kmmovies.pics/" &&
      href !== "https://kmmovies.pics"
    ) {
      if (!posts.some((p) => p.url === href) && rawTitle.length > 2) {
        const yearMatch = rawTitle.match(/\b(19\d\d|20\d\d)\b/);
        const year = yearMatch ? parseInt(yearMatch[1]!, 10) : undefined;
        const qMatch = rawTitle.match(/\b(4K|2160p|1080p|720p|480p|WEB-DL|WEBRip|BluRay|HDTC)\b/i);
        const quality = qMatch ? qMatch[1] : undefined;

        posts.push({
          title: rawTitle,
          url: href,
          year,
          quality,
        });
      }
    }
  });

  return posts;
}

async function resolveSkydrop(skydropUrl: string): Promise<string | null> {
  try {
    const urlObj = new URL(skydropUrl);
    const id = urlObj.searchParams.get("id") || urlObj.searchParams.get("file");
    if (!id) return null;

    const host = urlObj.origin;
    const apiUrl = `${host}/api.php?file=${encodeURIComponent(id)}`;
    const res = await fetch(apiUrl, {
      headers: {
        ...DEFAULT_HEADERS,
        Referer: skydropUrl,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const data: any = await res.json();
    if (data && data.success) {
      const streamUrl = data.direct_download_url || data.link || data.download_url;
      if (streamUrl && (streamUrl.startsWith("http://") || streamUrl.startsWith("https://"))) {
        return streamUrl;
      }
    }
  } catch (err: any) {}
  return null;
}

export async function resolveMagicLinks(
  magicUrl: string,
  referer: string,
  targetEpisode?: number
): Promise<{ url: string; quality: string; size?: string; hostName: string; refreshUrl: string }[]> {
  const results: { url: string; quality: string; size?: string; hostName: string; refreshUrl: string }[] = [];
  const html = await fetchHtmlSafe(magicUrl, referer);
  if (!html) return results;

  const $ = cheerio.load(html);

  if (magicUrl.includes("episodes.magiclinks.lol")) {
    const epLinks: string[] = [];
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (href && (href.includes("skydrop") || href.includes("flexplayer") || href.includes("pixeldrain") || href.includes("gofile") || href.includes("download"))) {
        epLinks.push(href);
      }
    });

    if (epLinks.length > 0) {
      const epIdx = targetEpisode ? targetEpisode - 1 : 0;
      const chosenUrl = epLinks[epIdx] || epLinks[0];
      if (chosenUrl) {
        if (chosenUrl.includes("skydrop") || chosenUrl.includes("flexplayer")) {
          const direct = await resolveSkydrop(chosenUrl);
          if (direct) {
            results.push({ url: direct, quality: "HD", hostName: "Skydrop High-Speed Cloud", refreshUrl: magicUrl });
          }
        } else if (chosenUrl.includes("pixeldrain.com/u/")) {
          const pdId = chosenUrl.split("/u/")[1]?.split(/[?#]/)[0];
          if (pdId) {
            results.push({ url: `https://pixeldrain.com/api/file/${pdId}`, quality: "HD", hostName: "Pixeldrain Fast Stream", refreshUrl: magicUrl });
          }
        }
      }
    }
    return results;
  }

  const extractedHosts: { text: string; href: string }[] = [];
  $("a").each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, " ");
    const href = $(el).attr("href");
    if (href && !href.startsWith("#") && !href.includes("magiclinks.lol/about") && !href.includes("magiclinks.lol/contact") && !href.includes("magiclinks.lol/privacy")) {
      extractedHosts.push({ text, href });
    }
  });

  for (const host of extractedHosts) {
    const href = host.href;
    const label = host.text;

    if (label.includes("WATCH ONLINE") || href.includes("videoUrl=") || href.includes(".r2.dev/")) {
      let directUrl = href;
      if (href.includes("videoUrl=")) {
        const parsed = new URL(href).searchParams.get("videoUrl");
        if (parsed) directUrl = parsed;
      } else if (href.includes("/online.php")) {
        const resolved = await resolveOnlineMediaUrl(href);
        if (resolved) directUrl = resolved;
      }
      if (isAllowedMediaUrl(directUrl)) {
        if (directUrl.includes("download99.php") || directUrl.includes("clouddownload.php")) {
          const resolvedLinks = await resolveDownloadPage(directUrl);
          for (const resolved of resolvedLinks) {
            results.push({ url: resolved, quality: "HD", hostName: "Direct R2 Cloud Stream", refreshUrl: magicUrl });
          }
        } else {
          results.push({ url: directUrl, quality: "HD", hostName: "Direct R2 Cloud Stream", refreshUrl: magicUrl });
        }
      }
    }

    if (href.includes("skydrop") || href.includes("flexplayer") || label.includes("SKYDROP")) {
      const direct = await resolveSkydrop(href);
      if (direct) {
        results.push({ url: direct, quality: "HD", hostName: "Skydrop 10Gbps Cloud", refreshUrl: magicUrl });
      }
    }

    if (href.includes("pixeldrain.com/u/") || label.includes("PIXELDRAIN")) {
      const pdId = href.split("/u/")[1]?.split(/[?#]/)[0];
      if (pdId) {
        results.push({ url: `https://pixeldrain.com/api/file/${pdId}`, quality: "HD", hostName: "Pixeldrain Direct", refreshUrl: magicUrl });
      }
    }

    if (label.includes("ZIP-ZAP") || label.includes("ONE CLICK") || href.includes("download99.php") || href.includes("clouddownload.php") || href.includes("fddownload.php")) {
      if (href.includes("download99.php") || href.includes("clouddownload.php")) {
        const resolvedLinks = await resolveDownloadPage(href);
        for (const resolved of resolvedLinks) {
          results.push({ url: resolved, quality: "HD", hostName: "Fast Cloud Mirror", refreshUrl: magicUrl });
        }
      } else {
        results.push({ url: href, quality: "HD", hostName: "Fast Cloud Mirror", refreshUrl: magicUrl });
      }
    }
  }

  return results;
}

export async function getKMMoviesStreams(
  title: string,
  type: "movie" | "series",
  year?: number | null,
  season?: number | null,
  episode?: number | null
  ,sourceUrl?: string
): Promise<KMMoviesStream[]> {
  const isSeries = type === "series";
  const searchQueries: string[] = [];

  if (isSeries && season) {
    const sPadded = season < 10 ? `S0${season}` : `S${season}`;
    searchQueries.push(`${title} ${sPadded}`);
    searchQueries.push(`${title} Season ${season}`);
  }
  searchQueries.push(title);
  if (year) {
    searchQueries.push(`${title} ${year}`);
  }

  let matchedPost: PostMatch | null = sourceUrl
    ? { title, url: sourceUrl, year: year ?? undefined }
    : null;

  if (!matchedPost) {
    const candidates = new Map<string, PostMatch>();
    for (const q of searchQueries) {
      const posts = await searchKMMovies(q);
      for (const post of posts) candidates.set(post.url, post);
    }

    const normalizeWords = (value: string) =>
      value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    const titleWords = normalizeWords(title);
    const score = (post: PostMatch) => {
      const normalizedPost = normalizeWords(post.title);
      const wordSet = new Set(normalizedPost);
      const matchedWords = titleWords.filter((word) => wordSet.has(word)).length;
      let value = matchedWords * 10;
      if (titleWords.length > 0 && matchedWords === titleWords.length) value += 30;
      if (year && post.year === year) value += 100;
      else if (year && post.year !== undefined) value -= 75;
      return value;
    };

    matchedPost = [...candidates.values()].sort((a, b) => score(b) - score(a))[0] || null;
  }

  if (!matchedPost) {
    return [];
  }

  const postHtml = await fetchHtmlSafe(matchedPost.url);
  if (!postHtml) {
    return [];
  }

  const $ = cheerio.load(postHtml);
  const qualityLinks: QualityLink[] = [];

  $(".entry-content a, .post-content a, article a, a").each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, " ");
    const href = $(el).attr("href");

    if (
      href &&
      (href.includes("magiclinks") ||
        href.includes("download") ||
        href.includes("drive") ||
        href.includes("skydrop") ||
        href.includes("pixeldrain") ||
        href.includes("online.php"))
    ) {
      if (
        !href.startsWith("#") &&
        !isKMMoviesPageUrl(href) &&
        !href.includes("facebook.com") &&
        !href.includes("twitter.com") &&
        !href.includes("telegram") &&
        !href.includes("t.me") &&
        !href.includes("whatsapp")
      ) {
        const qMatch = text.match(/\b(4K|2160p|1080p|720p(?:\s*10bit)?|480p)\b/i) ||
          href.match(/\b(4K|2160p|1080p|720p|480p)\b/i);
        const quality = qMatch ? qMatch[0].toUpperCase() : "1080p";

        const sizeMatch = text.match(/\b(\d+(?:\.\d+)?\s*(?:GB|MB))\b/i);
        const size = sizeMatch ? sizeMatch[1].toUpperCase() : undefined;

        const isEpisodePage = href.includes("episodes.magiclinks.lol");

        qualityLinks.push({
          quality,
          size,
          url: href,
          isEpisodePage,
        });
      }
    }
  });

  if (qualityLinks.length === 0) {
    return [];
  }

  let targetLinks = qualityLinks;
  if (isSeries && qualityLinks.some((q) => q.isEpisodePage)) {
    targetLinks = qualityLinks.filter((q) => q.isEpisodePage);
  }

  const streams: KMMoviesStream[] = [];
  // KMMovies lists multiple encodes in quality order, but older entries can
  // remain published after their backing file is removed. Scan the complete
  // bounded list so a healthy later mirror is not hidden by stale entries.
  const resolvePromises = targetLinks.slice(0, 24).map(async (ql) => {
    try {
      const resolved = await resolveMagicLinks(ql.url, matchedPost!.url, episode ?? 1);
      for (const res of resolved) {
        const epLabel = isSeries ? `S${season || 1}E${episode || 1}` : "";
        const sizeLabel = ql.size ? ` · ${ql.size}` : "";
        const serverName = formatKMMoviesServerName(res.hostName);
        const titleLine = `${matchedPost!.title} · ${ql.quality}${epLabel ? ` · ${epLabel}` : ""}${sizeLabel} · ${serverName}`;

        streams.push({
          name: `🎬 KMMovies — ${serverName}\n${ql.quality}`,
          title: titleLine,
          url: res.url,
          refreshUrl: res.refreshUrl,
          quality: ql.quality,
          size: ql.size,
          audio: "Hindi / Dual Audio",
          behaviorHints: {
            proxyHeaders: {
              request: {
                "User-Agent": DEFAULT_HEADERS["User-Agent"],
                Referer: KMMOVIES_BASE + "/",
              },
            },
            notWebReady: false,
          },
        });
      }
    } catch (e: any) {}
  });

  await Promise.allSettled(resolvePromises);
  const uniqueStreams: KMMoviesStream[] = [];
  const seenUrls = new Set<string>();
  for (const stream of streams) {
    if (!seenUrls.has(stream.url)) {
      seenUrls.add(stream.url);
      uniqueStreams.push(stream);
    }
  }

  // The signed ZIP-ZAP/R2 links are intentionally short-lived and commonly
  // reject a probe that does not look exactly like a player request. These
  // streams carry refreshUrl, so the playback proxy can resolve a fresh link
  // when Stremio actually opens it. Preflighting them here made the provider
  // return zero streams even when the landing page was healthy.
  const refreshable = uniqueStreams.filter((stream) => !!stream.refreshUrl);
  const direct = uniqueStreams.filter((stream) => !stream.refreshUrl);
  const checkedDirect = await Promise.all(
    direct.map(async (stream) => ({
      stream,
      playable: await isPlayableVideoUrl(stream.url),
    })),
  );
  return [
    ...refreshable,
    ...checkedDirect.filter(({ playable }) => playable).map(({ stream }) => stream),
  ];
}
