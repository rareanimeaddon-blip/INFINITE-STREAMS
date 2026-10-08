import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The provider publishes this wasm-bindgen module alongside its API. It is
// bundled locally so a running add-on doesn't execute code fetched at runtime.
// @ts-ignore generated wasm-bindgen module
import stellarEngine from './stellar-engine.js';

const SITE_URL = (process.env.STELLAR_SITE_URL || 'https://stellar.gdn').replace(/\/$/, '');
const API = (process.env.STELLAR_API || 'https://api.stellar.gdn').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS || 20000);

export const PLAYBACK_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: `${SITE_URL}/`,
  Origin: SITE_URL,
};

const HEADERS: Record<string, string> = {
  ...PLAYBACK_HEADERS,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

async function fetchT(url: string, options: RequestInit = {}, timeout = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type StellarCryptoEngine = {
  initSync(options: { module: Uint8Array }): unknown;
  init_session(): void;
  set_time_offset(deltaMs: number): void;
  encrypt_request_payload(payloadJson: string): Uint8Array;
  decrypt_response_payload_bytes(payload: Uint8Array): string;
};

let enginePromise: Promise<StellarCryptoEngine> | null = null;

async function getCryptoEngine(): Promise<StellarCryptoEngine> {
  if (enginePromise) return enginePromise;

  const pending = (async () => {
    const engine = stellarEngine as StellarCryptoEngine;
    const enginePath = resolve(dirname(fileURLToPath(import.meta.url)), 'stellar-engine.wasm');
    engine.initSync({ module: await readFile(enginePath) });
    engine.init_session();

    // The current site client syncs its wasm clock to the API's Date header
    // before encrypting requests. The offset is bounded to avoid bad clocks.
    let offset = 0;
    try {
      const health = await fetchT(`${API}/api/health`, {
        method: 'HEAD',
        headers: PLAYBACK_HEADERS,
        cache: 'no-store',
      });
      const serverTime = Date.parse(health.headers.get('date') || '');
      const ageSeconds = Number(health.headers.get('age') || 0);
      const candidate = serverTime + ageSeconds * 1000 - Date.now();
      if (Number.isFinite(candidate) && Math.abs(candidate) <= 300_000) {
        offset = candidate;
      }
    } catch {
      // Zero offset matches the website client's fallback behavior.
    }
    engine.set_time_offset(offset);
    return engine;
  })();

  enginePromise = pending;
  pending.catch(() => {
    if (enginePromise === pending) enginePromise = null;
  });
  return pending;
}

async function resolveOnce(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const engine = await getCryptoEngine();
    const encrypted = engine.encrypt_request_payload(JSON.stringify(body));
    const res = await fetchT(`${API}/api/r`, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/octet-stream',
        Accept: 'application/octet-stream',
      },
      body: encrypted,
    });
    if (!res.ok) return null;
    const responseBytes = new Uint8Array(await res.arrayBuffer());
    const plaintext = engine.decrypt_response_payload_bytes(responseBytes);
    const data = JSON.parse(plaintext) as Record<string, unknown>;
    return data && data.url ? data : null;
  } catch {
    return null;
  }
}

interface StreamResult {
  url: string;
  quality: string;
  label: string;
  type: string;
  headers: Record<string, string>;
}

const RANKS: [RegExp, number][] = [
  [/auto/i, 0],
  [/2160|4k|uhd/i, 1],
  [/1080/i, 2],
  [/720/i, 3],
];
const rank = (q = '') => (RANKS.find(([re]) => re.test(q)) || [null, 4])[1];

export async function getStreams({
  tmdbId,
  type,
  season,
  episode,
}: {
  tmdbId: number;
  type: string;
  season?: number;
  episode?: number;
}): Promise<StreamResult[]> {
  const isTv = type === 'tv' || type === 'series';
  const body: Record<string, unknown> = {
    mediaType: isTv ? 'tv' : 'movie',
    id: String(tmdbId),
    ...(isTv ? { season: season || 1, episode: episode || 1 } : {}),
  };

  const first = await resolveOnce(body);
  if (!first) return [];

  const others = (Array.isArray(first.availableSources) ? first.availableSources : [])
    .filter((source): source is string => typeof source === 'string' && source !== first.source);
  const rest = await Promise.all(others.map((source) => resolveOnce({ ...body, source })));

  const out: StreamResult[] = [];
  const seen = new Set<string>();
  for (const r of [first, ...rest.filter(Boolean)] as Record<string, unknown>[]) {
    if (!r.url || seen.has(r.url as string)) continue;
    seen.add(r.url as string);
    const mediaUrl = r.url as string;
    const isHls = r.format === 'hls' || /\.m3u8(?:[?#]|$)/i.test(mediaUrl);
    out.push({
      url: mediaUrl,
      quality: typeof r.quality === 'string'
        ? r.quality
        : (isHls ? 'Auto (up to 4K)' : '1080p'),
      label: `Stellar [${r.source}]`,
      type: isHls ? 'hls' : 'video',
      headers: PLAYBACK_HEADERS,
    });
  }

  return out.sort((a, b) => rank(a.quality) - rank(b.quality));
}
