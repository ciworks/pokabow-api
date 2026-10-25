import { test } from "node:test";
import assert from "node:assert/strict";
import { onlineGemPot, onlineGemShares, verifiedAiGemPayout } from "../dist/services/gem-wallet.js";

const hand = (id, category) => ({ event_id: id, category: 0, evidence: { category } });

test("only distinct committed poker events contribute to an online pot", () => {
  const snapshot = { outcome: 1, ledger: { events: [
    hand("a", "PAIR"), hand("b", "PAIR"), hand("c", "FULL_HOUSE"),
    hand("b", "PAIR"), { event_id: "edge", category: 1, evidence: { category: "PAIR" } },
    hand("unknown", "NOT_A_HAND"),
  ] } };
  assert.equal(onlineGemPot(snapshot), 16);
});

test("normal finishes grant completion, resignations grant pot only", () => {
  assert.deepEqual(onlineGemShares(1, 1, 20), { humanPot: 20, aiPot: 0, completion: 10 });
  assert.deepEqual(onlineGemShares(3, 2, 20), { humanPot: 10, aiPot: 10, completion: 10 });
  assert.deepEqual(onlineGemShares(2, 5, 20), { humanPot: 0, aiPot: 20, completion: 0 });
  assert.throws(() => onlineGemShares(3, 1, 3), /INVALID_GEM_SETTLEMENT/);
});

test("verified AI pot follows the lowest difficulty and terminal result", () => {
  const snapshot = { outcome: 1, end_reason: 1, ledger: { events: [
    hand("a", "FULL_HOUSE"), hand("b", "FOUR_OF_A_KIND"),
    hand("c", "FOUR_OF_A_KIND"), hand("d", "FOUR_OF_A_KIND"),
    hand("e", "FOUR_OF_A_KIND"), hand("f", "FOUR_OF_A_KIND"),
  ] } };
  assert.deepEqual(verifiedAiGemPayout(snapshot, 0), { pot: 20, amount: 20 });
  assert.deepEqual(verifiedAiGemPayout(snapshot, 1), { pot: 40, amount: 40 });
  assert.deepEqual(verifiedAiGemPayout(snapshot, 2), { pot: 80, amount: 80 });
  assert.deepEqual(verifiedAiGemPayout({ ...snapshot, outcome: 3 }, 0), { pot: 20, amount: 10 });
  assert.deepEqual(verifiedAiGemPayout({ ...snapshot, outcome: 2 }, 2), { pot: 80, amount: 0 });
  assert.deepEqual(verifiedAiGemPayout({ ...snapshot, end_reason: 5 }, 2), { pot: 80, amount: 0 });
});
