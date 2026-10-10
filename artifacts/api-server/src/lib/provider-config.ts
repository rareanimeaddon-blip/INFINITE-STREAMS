/**
 * Provider configuration — controls which providers are used for stream aggregation.
 *
 * Provider order must match the landing-page checkboxes.
 * The config mask has one bit per provider.
 * '1' means enabled, '0' means disabled.
 * ALL_PROVIDERS_MASK enables every current provider by default.
 */

export const PROVIDER_LIST = [
  "kartoons",
  "animesalt",
  "animeworld",
  "rareanime",
  "animedekho",
  "piratexplay",
  "netmirror",
  "streamflix",
  "stellar",
  "dooflix",
  "castletv",
  "onetouchtv",
  "vidlink",
  "cinejoy",
  "moviebox",
  "showbox",
  "meowtv",
  "moviesdrive",
  "vaplayer",
  "cinefreak",
  "hindmovies",
  "kmmovies",
  "fourkdhub",
  "hdhub4u",
  "zxcstreams",
] as const;

export type ProviderKey = (typeof PROVIDER_LIST)[number];

export const ALL_PROVIDERS_MASK = "1".repeat(PROVIDER_LIST.length);

export function parseProviderConfig(config: string): Set<ProviderKey> {
  const enabled = new Set<ProviderKey>();
  for (let i = 0; i < PROVIDER_LIST.length; i++) {
    if (!config[i] || config[i] !== "0") {
      enabled.add(PROVIDER_LIST[i]!);
    }
  }
  return enabled;
}

export function isEnabled(config: Set<ProviderKey>, provider: ProviderKey): boolean {
  return config.has(provider);
}

export function maskToConfig(mask: string): Set<ProviderKey> {
  let clean = mask.replace(/[^01]/g, "1");
  // New custom install URLs carry a trailing sentinel bit so they stay
  // distinguishable from older 25-bit masks with a retired slot.
  if (clean.length === PROVIDER_LIST.length + 1) {
    clean = clean.slice(0, PROVIDER_LIST.length);
  } else if (clean.length === PROVIDER_LIST.length) {
    // Older 25-bit masks have one retired slot before VaPlayer. Drop it, then
    // insert Cinejoy after VidLink with the default-enabled selection.
    clean = `${clean.slice(0, 17)}${clean.slice(18)}`;
    clean = `${clean.slice(0, 13)}1${clean.slice(13)}`;
  } else if (clean.length === PROVIDER_LIST.length - 1) {
    // Previous current masks had 24 providers; preserve their selections when
    // adding Cinejoy in the middle of the list.
    clean = `${clean.slice(0, 13)}1${clean.slice(13)}`;
  }
  clean = clean.padEnd(PROVIDER_LIST.length, "1");
  return parseProviderConfig(clean);
}
