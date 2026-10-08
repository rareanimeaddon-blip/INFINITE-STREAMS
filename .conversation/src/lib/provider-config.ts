/**
 * Provider configuration — controls which providers are used for stream aggregation.
 *
 * Provider order must match the landing-page checkboxes.
 * The config mask has one bit per provider.
 * '1' means enabled, '0' means disabled.
 * "1111111111111111111111111" = all providers enabled (default).
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
  "moviebox",
  "showbox",
  "meowtv",
  "moviesdrive",
  "hdghartv",
  "vaplayer",
  "cinefreak",
  "hindmovies",
  "kmmovies",
  "fourkdhub",
  "hdhub4u",
  "zxcstreams",
] as const;

export type ProviderKey = (typeof PROVIDER_LIST)[number];

export const ALL_PROVIDERS_MASK = "1111111111111111111111111";

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
  const clean = mask.replace(/[^01]/g, "1").padEnd(PROVIDER_LIST.length, "1");
  return parseProviderConfig(clean);
}
