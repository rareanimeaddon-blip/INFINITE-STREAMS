import test from "node:test";
import assert from "node:assert/strict";
import {
  ANIMEDEKHO_BASE_URL,
  isAnimeDekhoContentPage,
  isAnimeDekhoOwnedPath,
  isAnimeDekhoUrl,
} from "../src/providers/animedekho/domain.js";

test("AnimeDekho uses its current canonical host", () => {
  assert.equal(ANIMEDEKHO_BASE_URL, "https://animedekho.tv");
});

test("current .tv and legacy .app content URLs are accepted", () => {
  assert.equal(isAnimeDekhoContentPage("https://animedekho.tv/series-hindi/naruto/"), true);
  assert.equal(isAnimeDekhoContentPage("https://animedekho.app/movie-hindi/example/"), true);
  assert.equal(isAnimeDekhoUrl("https://www.animedekho.tv/aaa/myth/play.php?id=1"), true);
});

test("lookalike hosts, non-web protocols, and unrelated paths are rejected", () => {
  assert.equal(isAnimeDekhoUrl("https://animedekho.tv.example.org/aaa/"), false);
  assert.equal(isAnimeDekhoUrl("javascript://animedekho.tv/aaa/"), false);
  assert.equal(isAnimeDekhoContentPage("https://animedekho.tv/category/anime/"), false);
});

test("owned embed paths recognize both supported domains without matching lookalikes", () => {
  assert.equal(isAnimeDekhoOwnedPath("https://animedekho.tv/aaa/ad/vidsrc/1", "/aaa/ad/vidsrc/"), true);
  assert.equal(isAnimeDekhoOwnedPath("https://animedekho.app/aaa/down/v/1", "/aaa/down/v/"), true);
  assert.equal(isAnimeDekhoOwnedPath("https://animedekho.tv.evil/aaa/down/v/1", "/aaa/down/v/"), false);
});
