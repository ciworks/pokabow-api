import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

export type RulesState = {
  snapshot: { outcome: number; turn: { active_player_id: string; turn_number: number }; [key: string]: unknown };
  views: Record<string, Record<string, unknown>>;
};
export type RulesResult = RulesState | { error: string };
export type RulesRunner = (request: Record<string, unknown>) => Promise<RulesResult>;
export function onlineRulesAvailable() {
  return Boolean(process.env.GODOT_BIN && process.env.ONLINE_RULES_PROJECT);
}
const run = promisify(execFile);
let inFlight = 0;
/** Runs the game's existing domain rules, with no alternate scoring implementation.
 * Paths are operator configuration, never supplied by HTTP clients.
 */
export const runOnlineRules: RulesRunner = async request => {
  if (!onlineRulesAvailable()) throw new Error("ONLINE_RULES_NOT_CONFIGURED");
  if (inFlight >= 4) throw new Error("ONLINE_RULES_BUSY");
  inFlight++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "pokabow-rules-"));
    const input = join(directory, "input.json");
    const output = join(directory, "output.json");
    await writeFile(input, JSON.stringify(request), { mode: 0o600 });
    await run(process.env.GODOT_BIN!, [
      "--headless", "--path", process.env.ONLINE_RULES_PROJECT!,
      "--script", "res://tools/online_rules_worker.gd", "--", input, output,
    ], { timeout: request.action === "ai_move" ? 30000 : 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    const result = JSON.parse(await readFile(output, "utf8")) as RulesResult;
    if (!("error" in result) && (!result.snapshot || !result.views?.human || !result.views?.ai)) {
      throw new Error("INVALID_RULES_RESPONSE");
    }
    return result;
  } finally {
    inFlight--;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
};
