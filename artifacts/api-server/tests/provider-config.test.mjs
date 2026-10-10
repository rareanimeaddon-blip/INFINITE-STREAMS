import test from "node:test";
import assert from "node:assert/strict";
import { ALL_PROVIDERS_MASK, maskToConfig, PROVIDER_LIST } from "../src/lib/provider-config.ts";

test("the default provider mask enables every registered provider", () => {
  assert.equal(PROVIDER_LIST.length, 25);
  assert.equal(PROVIDER_LIST[PROVIDER_LIST.indexOf("vidlink") + 1], "cinejoy");
  assert.equal(ALL_PROVIDERS_MASK, "1".repeat(PROVIDER_LIST.length));
  assert.equal(maskToConfig(ALL_PROVIDERS_MASK).size, PROVIDER_LIST.length);
});

test("older saved masks retain provider selections after the retired slot", () => {
  const legacyMask = Array(25).fill("0");
  legacyMask[18] = "1";

  assert.deepEqual([...maskToConfig(legacyMask.join(""))], ["cinejoy", "vaplayer"]);
});

test("previous 24-provider masks keep their selections after VidLink", () => {
  const previousMask = Array(24).fill("0");
  previousMask[13] = "1";

  assert.deepEqual([...maskToConfig(previousMask.join(""))], ["cinejoy", "moviebox"]);
});

test("versioned 26-bit masks preserve new provider selections", () => {
  const currentMask = `${"0".repeat(PROVIDER_LIST.length)}0`;

  assert.deepEqual([...maskToConfig(currentMask)], []);
});
