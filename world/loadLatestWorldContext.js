import fs from "fs";
import path from "path";

const CONTEXT_PATH = path.join(process.cwd(), "data", "world-context.jsonl");

export function loadLatestWorldContext() {
  if (!fs.existsSync(CONTEXT_PATH)) return null;
  const raw = fs.readFileSync(CONTEXT_PATH, "utf8");
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (!entries.length) return null;
  return entries
    .filter((entry) => entry.generated_at)
    .sort((a, b) => Date.parse(a.generated_at) - Date.parse(b.generated_at))
    .at(-1);
}
