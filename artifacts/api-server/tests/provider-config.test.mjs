import test from "node:test";
import assert from "node:assert/strict";
import { ALL_PROVIDERS_MASK, maskToConfig, PROVIDER_LIST } from "../src/lib/provider-config.ts";

test("the default provider mask enables every registered provider", () => {
  assert.equal(PROVIDER_LIST.length, 24);
  assert.equal(ALL_PROVIDERS_MASK, "1".repeat(PROVIDER_LIST.length));
  assert.equal(maskToConfig(ALL_PROVIDERS_MASK).size, PROVIDER_LIST.length);
});

test("older saved masks retain provider selections after the retired slot", () => {
  const legacyMask = Array(25).fill("0");
  legacyMask[18] = "1";

  assert.deepEqual([...maskToConfig(legacyMask.join(""))], ["vaplayer"]);
});
