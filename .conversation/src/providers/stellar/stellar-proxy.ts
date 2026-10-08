/**
 * HLS/segment reverse proxy.
 *
 * Stremio mobile cannot inject Referer/Origin headers and has no local proxy.
 * This endpoint fetches Stellar content server-side (adding the required
 * headers) and rewrites m3u8 playlists so every URL continues to flow through
 * here — ensuring auth headers are always present.
 *
 * Endpoints:
 *   GET /api/stellar-proxy?url=<encoded>          — auto-detect m3u8 vs segment
 */

import { Router, type IRouter, type Request, type Response } from 'express';
import { PLAYBACK_HEADERS } from './stellar.js';
import { BASE_PATH } from '../../lib/base-path.js';

const router: IRouter = Router();

const TIMEOUT_MS = 20_000;

async function fetchWithHeaders(url: string, range?: string): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { ...PLAYBACK_HEADERS, ...(range ? { Range: range } : {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a possibly-relative URL against a source URL. */
function toAbsolute(url: string, sourceUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const base = new URL(sourceUrl);
  if (url.startsWith('/')) return `${base.origin}${url}`;
  const baseDir = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);
  return `${baseDir}${url}`;
}

/** Rewrite all URLs inside an m3u8 playlist to go through our proxy. */
function rewriteM3U8(content: string, sourceUrl: string, proxyBase: string): string {
  // 1. Rewrite bare URL lines (non-comment lines that are URLs or relative paths)
  let result = content.replace(/^([^#\s][^\s]*)$/gm, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    const absolute = toAbsolute(trimmed, sourceUrl);
    return `${proxyBase}?url=${encodeURIComponent(absolute)}`;
  });

  // 2. Rewrite URI="..." attributes inside #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, etc.
  result = result.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
    const absolute = toAbsolute(uri, sourceUrl);
    return `URI="${proxyBase}?url=${encodeURIComponent(absolute)}"`;
  });

  return result;
}

function getProxyBase(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
  return `${proto}://${host}${BASE_PATH}/stellar-proxy`;
}

router.get('/stellar-proxy', async (req: Request, res: Response) => {
  const rawUrl = req.query.url as string;
  if (!rawUrl) {
    res.status(400).json({ error: 'Missing url query param' });
    return;
  }

  let targetUrl: string;
  try {
    // Express has already URL-decoded the query value once. Decoding again
    // corrupts signed URLs containing percent-encoded path/query bytes.
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Unsupported protocol');
    }
    targetUrl = parsed.toString();
  } catch {
    res.status(400).json({ error: 'Invalid url' });
    return;
  }

  try {
    const upstream = await fetchWithHeaders(targetUrl, req.headers.range as string | undefined);

    if (!upstream.ok) {
      res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist =
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegurl') ||
      targetUrl.includes('.m3u8') ||
      targetUrl.includes('m3u8-proxy');

    // CORS headers so Stremio web/mobile can fetch freely
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (isPlaylist) {
      const text = await upstream.text();
      const proxyBase = getProxyBase(req);
      const rewritten = rewriteM3U8(text, targetUrl, proxyBase);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(rewritten);
    } else {
      // Binary segment — stream the body through
      res.setHeader('Content-Type', contentType || 'video/MP2T');
      const buf = await upstream.arrayBuffer();
      res.send(Buffer.from(buf));
    }
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
