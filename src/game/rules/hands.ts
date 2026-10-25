/** The ranked hands accepted by the current Godot rules (ADR-012). */
export type HandCategory = "PAIR" | "THREE_OF_A_KIND" | "FOUR_OF_A_KIND" |
  "TWO_PAIR" | "FULL_HOUSE" | "STRAIGHT_3" | "STRAIGHT_4";

export function classifyRanks(ranks: readonly number[]): HandCategory | null {
  if (ranks.length < 2 || ranks.length > 5 ||
    ranks.some(rank => !Number.isInteger(rank) || rank < 0 || rank > 3)) return null;
  const frequencies = [...new Set(ranks)].map(rank => ranks.filter(value => value === rank).length)
    .sort((a, b) => b - a);
  if (ranks.length >= 3 && ranks.length <= 4 &&
    (ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] + 1) ||
      ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] - 1))) {
    return ranks.length === 3 ? "STRAIGHT_3" : "STRAIGHT_4";
  }
  // Every group of equal ranks must occupy one contiguous block.
  if (ranks.some((rank, index) => index > 0 && rank !== ranks[index - 1] &&
    ranks.slice(0, index).includes(rank))) return null;
  const shape = frequencies.join(",");
  if (ranks.length === 2 && shape === "2") return "PAIR";
  if (ranks.length === 3 && shape === "3") return "THREE_OF_A_KIND";
  if (ranks.length === 4 && shape === "4") return "FOUR_OF_A_KIND";
  if (ranks.length === 4 && shape === "2,2") return "TWO_PAIR";
  if (ranks.length === 5 && shape === "3,2") return "FULL_HOUSE";
  return null;
}
