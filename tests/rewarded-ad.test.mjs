import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { test } from "node:test";

process.env.ADMOB_REWARDED_AD_UNITS = "ca-app-pub-1234567890123456/1234567890";
const { verifyRewardedAdCallback } = await import("../dist/services/rewarded-ad.js");

test("rewarded SSV requires an intact signed payload and configured unit", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signed = [
    "ad_unit=1234567890",
    "custom_data=11111111-1111-4111-8111-111111111111",
    "reward_amount=20",
    `timestamp=${Date.now()}`,
    "transaction_id=abcdef012345",
    "user_id=22222222-2222-4222-8222-222222222222",
  ].join("&");
  const signer = createSign("SHA256");
  signer.update(signed);
  const signature = signer.sign(privateKey).toString("base64url");
  const url = `/gems/rewarded-ad/callback?${signed}&signature=${signature}&key_id=123`;
  const getKeys = async () => [{ keyId: 123, pem: publicKey.export({ type: "spki", format: "pem" }) }];
  assert.equal((await verifyRewardedAdCallback(url, getKeys)).valid, true);
  assert.equal((await verifyRewardedAdCallback(url.replace("reward_amount=20", "reward_amount=200"), getKeys)).valid, false);
  assert.equal((await verifyRewardedAdCallback(url.replace("ad_unit=1234567890", "ad_unit=999"), getKeys)).valid, false);
  assert.equal((await verifyRewardedAdCallback(url, async () => [])).valid, false);
});
