import { Router } from "express";
import { Readable } from "node:stream";
import {
  KMMOVIES_BASE,
  isAllowedMediaUrl,
  isPlayableVideoUrl,
  resolveMagicLinks,
  resolveDownloadPage,
} from "./kmmovies.js";

const router = Router();

export function proxyKMMoviesStreams(
  streams: Array<{ refreshUrl?: string; url: string; behaviorHints?: Record<string, unknown> }>,
  apiBase: string,
): Record<string, unknown>[] {
  return streams.map((stream) => {
    const { refreshUrl, ...publicStream } = stream;
    const params = new URLSearchParams({
      u: Buffer.from(stream.url, "utf8").toString("base64url"),
    });
    if (refreshUrl) {
      params.set("r", Buffer.from(refreshUrl, "utf8").toString("base64url"));
    }
    return {
      ...publicStream,
      url: `${apiBase}/kmmovies/proxy?${params.toString()}`,
      behaviorHints: {
        ...(stream.behaviorHints ?? {}),
        proxyHeaders: undefined,
      },
    };
  });
}

router.get("/kmmovies/proxy", async (req, res) => {
  const encodedUrl = typeof req.query.u === "string" ? req.query.u : "";
  if (!encodedUrl) return res.status(400).json({ error: "Missing media URL" });

  let mediaUrl = "";
  try {
    mediaUrl = Buffer.from(encodedUrl, "base64url").toString("utf8");
  } catch {
    return res.status(400).json({ error: "Invalid media URL" });
  }
  if (!isAllowedMediaUrl(mediaUrl)) {
    return res.status(403).json({ error: "Media host is not allowed" });
  }

  let refreshUrl = "";
  const encodedRefreshUrl = typeof req.query.r === "string" ? req.query.r : "";
  if (encodedRefreshUrl) {
    try {
      refreshUrl = Buffer.from(encodedRefreshUrl, "base64url").toString("utf8");
      const refreshHost = new URL(refreshUrl).hostname;
      if (
        !refreshHost.endsWith(".magiclinks.lol") &&
        !refreshHost.endsWith(".kmmovies.pics") &&
        !refreshHost.endsWith(".kmmovies.rest")
      ) {
        refreshUrl = "";
      }
    } catch {
      refreshUrl = "";
    }
  }

  try {
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    const requestHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      Referer: `${KMMOVIES_BASE}/`,
      ...(range ? { Range: range } : {}),
    };

    const fetchUpstream = (url: string) =>
      fetch(url, {
        headers: requestHeaders,
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });

    let upstream = await fetchUpstream(mediaUrl);
    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();

    // R2/Worker links expire quickly and ZIP-ZAP can return its HTML landing
    // page instead of media. Refresh the landing page and retry its newest
    // signed links before reporting a playback failure to Stremio.
    if (
      (!upstream.ok ||
        contentType.includes("text/html") ||
        contentType.includes("application/json")) &&
      (refreshUrl || mediaUrl.includes("download99.php") || mediaUrl.includes("clouddownload.php"))
    ) {
      let freshLinks: string[] = [];
      if (refreshUrl) {
        const refreshed = await resolveMagicLinks(refreshUrl, `${KMMOVIES_BASE}/`);
        freshLinks = refreshed.map((candidate) => candidate.url);
      } else {
        const landingUrl = new URL(mediaUrl);
        landingUrl.searchParams.delete("dl");
        landingUrl.searchParams.delete("exp");
        landingUrl.searchParams.delete("sig");
        freshLinks = await resolveDownloadPage(landingUrl.toString());
      }
      for (const freshLink of freshLinks) {
        if (!isAllowedMediaUrl(freshLink)) continue;
        if (!(await isPlayableVideoUrl(freshLink))) continue;
        const retry = await fetchUpstream(freshLink);
        const retryType = (retry.headers.get("content-type") || "").toLowerCase();
        if (retry.ok && !retryType.includes("text/html") && !retryType.includes("application/json")) {
          upstream = retry;
          break;
        }
      }
    }

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({ error: "Upstream media is unavailable" });
    }

    for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(upstream.status);
    if (req.method === "HEAD" || !upstream.body) return res.end();

    const body = Readable.fromWeb(upstream.body as never);
    body.on("error", () => {
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      if (!res.writableEnded) body.destroy();
    });
    return body.pipe(res);
  } catch {
    return res.status(502).json({ error: "Unable to reach upstream media" });
  }
});

export default router;
