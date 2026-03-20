import fs from "fs";
import path from "path";

import { classifyMacroFromTags, fuseMacroRegime } from "./contextUtils.js";

const CONTEXT_PATH = path.join(process.cwd(), "data", "world-context.jsonl");

function parseLatest(raw) {
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (!entries.length) return null;

  return entries
    .filter((entry) => entry.generated_at)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return Date.parse(a.generated_at) - Date.parse(b.generated_at);
    })
    .at(-1);
}

export async function loadLatestWorldContext() {
  try {
    if (!fs.existsSync(CONTEXT_PATH)) return null;
    const raw = fs.readFileSync(CONTEXT_PATH, "utf8");
    const parsed = parseLatest(raw);
    if (!parsed) return null;
    const macroView = classifyMacroFromTags(parsed.tags ?? null);
    const finalRegime =
      parsed.final_regime ??
      fuseMacroRegime({
        macroView,
        scoutLabel: parsed.scout_label,
        scoutScore: parsed.scout_score,
      });
    return { ...parsed, macro_view: macroView, final_regime: finalRegime };
  } catch (err) {
    console.error(
      "[world] loadLatestWorldContext failed:",
      err?.message ?? err
    );
    return null;
  }
}
