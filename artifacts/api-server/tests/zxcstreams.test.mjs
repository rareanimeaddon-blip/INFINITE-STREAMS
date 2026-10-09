import assert from "node:assert/strict";
import { test } from "node:test";
import { getAllStreams } from "../src/providers/zxcstreams/zxc.ts";

test("ZXC streams use the live player token endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET";
    requests.push({ method, host: url.host, path: url.pathname });

    if (url.hostname === "zxcstream.xyz" || url.hostname === "zxcprime.xyz") {
      return {
        ok: true,
        status: 200,
        url: "https://player.zxcprime.xyz/",
      };
    }

    if (url.pathname === "/oink/nigga") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "test-token", ts: 1_800_000_000_000 }),
      };
    }

    if (url.pathname.startsWith("/backend_/sources/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, links: [] }),
      };
    }

    throw new Error(`Unexpected ZXC request: ${method} ${url.pathname}`);
  };

  try {
    const streams = await getAllStreams(
      "movie",
      {
        tmdbId: "872585",
        title: "Test Movie",
        year: "2023",
        releaseDate: "2023-01-01",
        imdbId: "tt15398776",
      },
      null,
      null,
    );

    assert.deepEqual(streams, []);
    assert.equal(
      requests.filter(({ path }) => path === "/oink/nigga").length,
      4,
      "discovery plus each stream server should request a token",
    );
    assert.equal(
      requests.filter(({ path }) => path.startsWith("/backend_/sources/")).length,
      3,
      "all three ZXC stream servers should be queried",
    );
    assert.equal(
      requests.some(({ path }) => path === "/arf/stfunigga"),
      false,
      "the retired token endpoint must not be used",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
