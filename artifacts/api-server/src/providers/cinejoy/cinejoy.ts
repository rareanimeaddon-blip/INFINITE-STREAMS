import { createDecipheriv, type DecipherGCM } from "node:crypto";
import type { Stream } from "../../extractors/types.js";
import { logger } from "../../lib/logger.js";

const CINEJOY_URL = "https://cinejoy.pk";
const ENCRYPTION_URL = "https://enc-dec.app/api/enc-cinejoy";
const API_BASES = ["https://api.wing.st", "https://api.shegu.st"] as const;
export const CINEJOY_SERVERS = ["Nebula", "Lisbon", "solara", "athnes"] as const;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const REQUEST_HEADERS = {
  "User-Agent": USER_AGENT,
  Origin: CINEJOY_URL,
  Referer: `${CINEJOY_URL}/`,
};
const REQUEST_TIMEOUT_MS = 20_000;
const PLAYLIST_TIMEOUT_MS = 12_000;

interface CinejoyMeta {
  title?: string | null;
  year?: string | number | null;
  imdbId?: string | null;
}

interface SubtitleTrack {
  id: string;
  url: string;
  lang: string;
}

interface CinejoyStream extends Stream {
  quality: string;
  subtitles?: SubtitleTrack[];
}

interface SealedSession {
  body: Buffer;
  responseKey: Buffer;
  aad: Buffer;
}

function decodeBase64(value: unknown): Buffer {
  const normalized = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

async function createEncryptedSession(
  tmdbId: string,
  mediaType: "movie" | "series",
  server: string,
  season: number,
  episode: number,
  meta: CinejoyMeta,
): Promise<SealedSession> {
  const target = new URL("https://api.shegu.xyz/");
  target.searchParams.set("type", mediaType);
  target.searchParams.set("tmdb", tmdbId);
  target.searchParams.set("server", server);
  if (mediaType === "series") {
    target.searchParams.set("season", String(season));
    target.searchParams.set("episode", String(episode));
  }
  if (meta.title) target.searchParams.set("title", meta.title);
  if (meta.year) target.searchParams.set("year", String(meta.year));
  if (meta.imdbId) target.searchParams.set("imdb", meta.imdbId);

  const proxyUrl = new URL(ENCRYPTION_URL);
  proxyUrl.searchParams.set("url", target.toString());
  const response = await fetch(proxyUrl, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Cinejoy session encoder HTTP ${response.status}`);

  const payload = (await response.json()) as {
    status?: number;
    result?: {
      data?: string;
      state?: { responseKey?: string; aad?: string };
    };
    error?: string;
  };
  const session = payload.result;
  if (
    payload.status !== 200 ||
    typeof session?.data !== "string" ||
    typeof session.state?.responseKey !== "string" ||
    typeof session.state?.aad !== "string"
  ) {
    throw new Error(payload.error || "Cinejoy session encoder returned an incomplete session");
  }

  const body = decodeBase64(session.data);
  const responseKey = decodeBase64(session.state.responseKey);
  const aad = decodeBase64(session.state.aad);
  if (!body.length || ![16, 24, 32].includes(responseKey.length)) {
    throw new Error("Cinejoy session encoder returned invalid cryptographic data");
  }
  return { body, responseKey, aad };
}

function decryptSealedResponse(encryptedData: Buffer, session: SealedSession): string {
  if (encryptedData.length < 12 + 16) throw new Error("Cinejoy returned an incomplete encrypted response");
  const iv = encryptedData.subarray(0, 12);
  const ciphertext = encryptedData.subarray(12, -16);
  const authTag = encryptedData.subarray(-16);
  const decipher = createDecipheriv(
    `aes-${session.responseKey.length * 8}-gcm`,
    session.responseKey,
    iv,
  ) as DecipherGCM;
  if (session.aad.length) decipher.setAAD(session.aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function extractHlsVariants(
  playlist: string,
  playlistUrl: string,
): Array<{ height: number; url: string }> {
  const variants: Array<{ height: number; url: string }> = [];
  let pendingHeight: number | null = null;
  for (const rawLine of playlist.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const match = line.match(/RESOLUTION=\d+x(\d+)/i);
      pendingHeight = match ? Number(match[1]) : 0;
    } else if (line && !line.startsWith("#") && pendingHeight !== null) {
      try {
        variants.push({ height: pendingHeight, url: new URL(line, playlistUrl).toString() });
      } catch {
        // Ignore malformed playlist entries without affecting the other variants.
      }
      pendingHeight = null;
    }
  }
  return variants;
}

function normalizeQuality(rawValue: string): "4K" | "1080p" | null {
  const value = rawValue.toLowerCase();
  if (value.includes("2160") || value.includes("4k")) return "4K";
  if (value.includes("1080") || value.includes("fhd")) return "1080p";
  return null;
}

function normalizeSubtitles(rawTracks: unknown): SubtitleTrack[] {
  if (!Array.isArray(rawTracks)) return [];
  return rawTracks
    .map((track) => {
      const item = track as Record<string, unknown>;
      const url = typeof item.url === "string" ? item.url.trim() : "";
      const lang = String(item.language || item.id || "en").toLowerCase();
      return url ? { id: url, url, lang } : null;
    })
    .filter((track): track is SubtitleTrack => track !== null);
}

async function resolveStreamItems(
  rawItems: unknown,
  server: string,
): Promise<CinejoyStream[]> {
  if (!Array.isArray(rawItems)) return [];
  const streamHeaders = REQUEST_HEADERS;
  const jobs = rawItems.map(async (rawItem): Promise<CinejoyStream[]> => {
    if (!rawItem || typeof rawItem !== "object") return [];
    const item = rawItem as Record<string, unknown>;
    const subtitles = normalizeSubtitles(item.captions);
    const streams: CinejoyStream[] = [];

    if (item.type === "hls" && typeof item.playlist === "string") {
      try {
        const response = await fetch(item.playlist, {
          headers: streamHeaders,
          signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS),
        });
        if (!response.ok) return [];
        const variants = extractHlsVariants(await response.text(), item.playlist);
        for (const variant of variants) {
          if (variant.height !== 2160 && variant.height !== 1080) continue;
          const quality = variant.height === 2160 ? "4K" : "1080p";
          streams.push({
            name: `Cinejoy · ${server}`,
            title: `Cinejoy · ${server} · ${quality}`,
            url: variant.url,
            type: "hls",
            quality,
            behaviorHints: { proxyHeaders: { request: streamHeaders }, notWebReady: false },
            ...(subtitles.length ? { subtitles } : {}),
          });
        }
      } catch {
        return [];
      }
    } else if (item.type === "file" && item.qualities && typeof item.qualities === "object") {
      for (const [rawQuality, rawEntry] of Object.entries(item.qualities as Record<string, unknown>)) {
        const quality = normalizeQuality(rawQuality);
        const entry = rawEntry as Record<string, unknown> | null;
        const url = typeof entry?.url === "string" ? entry.url : "";
        if (!quality || !url.startsWith("http")) continue;
        streams.push({
          name: `Cinejoy · ${server}`,
          title: `Cinejoy · ${server} · ${quality}`,
          url,
          type: "mp4",
          quality,
          behaviorHints: { proxyHeaders: { request: streamHeaders }, notWebReady: false },
          ...(subtitles.length ? { subtitles } : {}),
        });
      }
    }
    return streams;
  });

  const settled = await Promise.allSettled(jobs);
  const seen = new Set<string>();
  return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((stream) => {
      if (seen.has(stream.url)) return false;
      seen.add(stream.url);
      return true;
    });
}

async function getStreamsFromServer(
  tmdbId: string,
  mediaType: "movie" | "series",
  season: number,
  episode: number,
  meta: CinejoyMeta,
  server: string,
): Promise<CinejoyStream[]> {
  try {
    const session = await createEncryptedSession(tmdbId, mediaType, server, season, episode, meta);
    let response: Response | null = null;
    for (const base of API_BASES) {
      try {
        response = await fetch(`${base}/g`, {
          method: "POST",
          body: session.body,
          headers: {
            ...REQUEST_HEADERS,
            "Content-Type": "application/octet-stream",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) break;
      } catch {
        response = null;
      }
    }
    if (!response?.ok) return [];

    const encrypted = Buffer.from(await response.arrayBuffer());
    const payload = JSON.parse(decryptSealedResponse(encrypted, session)) as {
      data?: { stream?: unknown };
    };
    const streams = await resolveStreamItems(payload.data?.stream, server);
    logger.debug({ server, count: streams.length }, "Cinejoy server lookup complete");
    return streams;
  } catch (error) {
    logger.debug(
      { server, err: error instanceof Error ? error.message : String(error) },
      "Cinejoy server lookup failed",
    );
    return [];
  }
}

export async function getCinejoyStreams(
  tmdbId: string | number | null | undefined,
  mediaType: string,
  season = 1,
  episode = 1,
  meta: CinejoyMeta = {},
): Promise<CinejoyStream[]> {
  const normalizedId = String(tmdbId ?? "").trim();
  if (!/^\d+$/.test(normalizedId)) return [];
  if (mediaType !== "movie" && mediaType !== "series") return [];
  if (
    mediaType === "series" &&
    (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1)
  ) {
    return [];
  }

  const settled = await Promise.allSettled(
    CINEJOY_SERVERS.map((server) =>
      getStreamsFromServer(normalizedId, mediaType, season, episode, meta, server),
    ),
  );
  const seen = new Set<string>();
  return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((stream) => {
      if (seen.has(stream.url)) return false;
      seen.add(stream.url);
      return true;
    });
}
