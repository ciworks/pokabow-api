import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

/** Development-only reference runner for differential fixtures. */
export async function runGodotRules(request) {
  const directory = await mkdtemp(join(tmpdir(), "pokabow-reference-"));
  try {
    const input = join(directory, "input.json"), output = join(directory, "output.json");
    await writeFile(input, JSON.stringify(request));
    await promisify(execFile)(process.env.GODOT_BIN, ["--headless", "--path",
      process.env.ONLINE_RULES_PROJECT, "--script", "res://tools/online_rules_worker.gd",
      "--", input, output], { timeout: 30000, windowsHide: true });
    return JSON.parse(await readFile(output, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
