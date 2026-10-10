import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { CINEJOY_SERVERS, getCinejoyStreams } from "../src/providers/cinejoy/cinejoy.ts";

const responseKey = Buffer.from(
  "c1e2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c1e2a3b4c5d6e7f8a9b0c1d2e3f4a5b6",
  "hex",
);
const aad = Buffer.from("cinejoy-test-aad");

function encryptedApiResponse(server) {
  const iv = Buffer.alloc(12, CINEJOY_SERVERS.indexOf(server) + 1);
  const payload = {
    data: {
      stream: [
        {
          type: "file",
          qualities: {
            "2160p": { url: `https://cdn.example/${server}/2160.mp4` },
            "1080p": { url: `https://cdn.example/${server}/1080.mp4` },
            "720p": { url: `https://cdn.example/${server}/720.mp4` },
          },
          captions: [{ language: "EN", url: `https://sub.example/${server}.vtt` }],
        },
        {
          type: "hls",
          playlist: `https://cdn.example/${server}/master.m3u8`,
        },
      ],
    },
  };
  const cipher = createCipheriv("aes-256-gcm", responseKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return Buffer.concat([iv, ciphertext]);
}

function mockFetch(t, { failedServer } = {}) {
  const originalFetch = globalThis.fetch;
  const requestedServers = new Set();
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.hostname === "enc-dec.app") {
      const target = new URL(url.searchParams.get("url"));
      const server = target.searchParams.get("server");
      requestedServers.add(server);
      if (server === failedServer) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({
        status: 200,
        result: {
          data: Buffer.from(server).toString("base64"),
          state: { responseKey: responseKey.toString("base64"), aad: aad.toString("base64") },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.hostname === "api.wing.st" && url.pathname === "/g") {
      const server = new TextDecoder().decode(options.body);
      return new Response(encryptedApiResponse(server), { status: 200 });
    }
    if (url.hostname === "cdn.example" && url.pathname.endsWith("/master.m3u8")) {
      return new Response(
        [
          "#EXTM3U",
          "#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160",
          "2160/index.m3u8",
          "#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080",
          "1080/index.m3u8",
          "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
          "720/index.m3u8",
        ].join("\n"),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return requestedServers;
}

test("Cinejoy queries every configured server and resolves high-quality file and HLS streams", async (t) => {
  const requestedServers = mockFetch(t);
  const streams = await getCinejoyStreams(42, "movie", 1, 1, {
    title: "Sample Film",
    year: 2024,
    imdbId: "tt1234567",
  });

  assert.deepEqual([...requestedServers].sort(), [...CINEJOY_SERVERS].sort());
  assert.equal(streams.length, CINEJOY_SERVERS.length * 4);
  assert.deepEqual(
    [...new Set(streams.map((stream) => stream.name.replace("Cinejoy · ", "")))].sort(),
    [...CINEJOY_SERVERS].sort(),
  );
  assert.ok(streams.some((stream) => stream.quality === "4K" && stream.type === "mp4"));
  assert.ok(streams.some((stream) => stream.quality === "1080p" && stream.type === "hls"));
  assert.ok(streams.every((stream) => !stream.url.includes("/720")));
  assert.deepEqual(streams.find((stream) => stream.type === "mp4")?.subtitles?.[0], {
    id: "https://sub.example/Nebula.vtt",
    url: "https://sub.example/Nebula.vtt",
    lang: "en",
  });
});

test("a failed Cinejoy server does not discard streams from the others", async (t) => {
  const requestedServers = mockFetch(t, { failedServer: "solara" });
  const streams = await getCinejoyStreams(42, "series", 1, 2, { title: "Sample Series" });
  const returnedServers = new Set(streams.map((stream) => stream.name.replace("Cinejoy · ", "")));

  assert.deepEqual([...requestedServers].sort(), [...CINEJOY_SERVERS].sort());
  assert.equal(returnedServers.has("solara"), false);
  assert.deepEqual([...returnedServers].sort(), ["Lisbon", "Nebula", "athnes"]);
  assert.ok(streams.length > 0);
});

test("invalid media identifiers are ignored without making requests", async (t) => {
  const requestedServers = mockFetch(t);

  assert.deepEqual(await getCinejoyStreams("tt1234567", "movie"), []);
  assert.deepEqual(await getCinejoyStreams(42, "tv"), []);
  assert.deepEqual(await getCinejoyStreams(42, "series", 0, 2), []);
  assert.equal(requestedServers.size, 0);
});
