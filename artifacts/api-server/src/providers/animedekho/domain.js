export const ANIMEDEKHO_BASE_URL = "https://animedekho.tv";

const ANIMEDEKHO_HOSTS = new Set([
  "animedekho.tv",
  "www.animedekho.tv",
  "animedekho.app",
  "www.animedekho.app",
]);

function parseAnimeDekhoUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!ANIMEDEKHO_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url;
  } catch {
    return null;
  }
}

export function isAnimeDekhoUrl(value) {
  return parseAnimeDekhoUrl(value) !== null;
}

export function isAnimeDekhoContentPage(value) {
  const url = parseAnimeDekhoUrl(value);
  return !!url && /^\/(?:serie|series-hindi|movies|movie|movie-hindi)\//.test(url.pathname);
}

export function isAnimeDekhoOwnedPath(value, pathPrefix) {
  const url = parseAnimeDekhoUrl(value);
  return !!url && url.pathname.startsWith(pathPrefix);
}
