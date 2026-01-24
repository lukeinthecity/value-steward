import fs from "fs";
import path from "path";

const CONTEXT_PATH = path.join(process.cwd(), "data", "world-context.jsonl");

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    console.error(
      `[world:inspect] Failed to parse ${filePath}: ${err?.message ?? err}`
    );
    return [];
  }
}

function getLatestContext(entries) {
  if (!entries.length) return null;
  return entries
    .slice()
    .sort((a, b) => {
      if (a.date !== b.date) {
        return String(b.date).localeCompare(String(a.date));
      }
      return Date.parse(b.generated_at ?? 0) - Date.parse(a.generated_at ?? 0);
    })
    .at(0);
}

function truncate(text, max = 120) {
  if (!text) return "(missing)";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function tagsHaveValues(tags) {
  if (!tags) return false;
  const keys = [
    "macro_risk",
    "rate_hawkishness",
    "geopolitical_tension",
    "energy_shock_risk",
    "recession_fear",
  ];
  return keys.some((key) => tags[key] !== null && tags[key] !== undefined);
}

function main() {
  const entries = loadJsonl(CONTEXT_PATH);
  if (!entries.length) {
    console.log(
      '[world:inspect] No world context entries found. Run "npm run world:run" first.'
    );
    process.exit(0);
  }

  const latest = getLatestContext(entries);
  if (!latest) {
    console.log(
      '[world:inspect] No valid world context entries found. Run "npm run world:run" first.'
    );
    process.exit(0);
  }

  const sourcesUsed = Array.isArray(latest.sources_used)
    ? latest.sources_used.length
    : 0;
  const hasNonNullTags = tagsHaveValues(latest.tags);

  console.log("[world:inspect] Latest world context");
  console.log(`- date: ${latest.date ?? "(missing)"}`);
  console.log(`- generated_at: ${latest.generated_at ?? "(missing)"}`);
  console.log(`- raw_count: ${latest.raw_count ?? "(missing)"}`);
  console.log(`- sources_used: ${sourcesUsed}`);
  console.log(
    `- tags status: ${hasNonNullTags ? "some set" : "all null (stub)"}`
  );
  if (latest.notes) {
    console.log(`- notes: ${latest.notes}`);
  }

  const preview = latest.corpus_preview ?? latest.hydration?.corpus_preview ?? [];
  if (!Array.isArray(preview) || preview.length === 0) {
    console.log("[world:inspect] No corpus_preview entries found.");
    process.exit(0);
  }

  console.log("[world:inspect] Corpus preview (up to 5 items):");
  preview.slice(0, 5).forEach((item, index) => {
    const sourceId = item?.source_id ?? "(missing)";
    const title = item?.title ?? "(missing)";
    const excerpt = truncate(item?.excerpt || item?.content_text || "");
    console.log(`${index + 1}) [${sourceId}] ${title}`);
    console.log(`   "${excerpt}"`);
  });
}

main();
