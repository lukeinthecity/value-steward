import fs from "fs";
import path from "path";

import { classifyMacroFromTags } from "./contextUtils.js";

const CONTEXT_PATH = path.join(process.cwd(), "data", "world-context.jsonl");

async function loadFromGitHub({ githubToken }) {
  const url = "https://api.github.com/repos/lukeinthecity/value-steward/contents/data/world-context.jsonl";
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "value-steward-agent",
    },
  });

  if (res.status === 404) return "";
  if (!res.ok) {
    throw new Error(`GitHub load failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return Buffer.from(data.content, "base64").toString("utf8");
}

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

export async function loadLatestWorldContext({ githubToken } = {}) {
  try {
    if (githubToken) {
      const raw = await loadFromGitHub({ githubToken });
      const parsed = raw ? parseLatest(raw) : null;
      if (!parsed) return null;
      const macroView = classifyMacroFromTags(parsed.tags ?? null);
      return { ...parsed, macro_view: macroView };
    }

    if (!fs.existsSync(CONTEXT_PATH)) return null;
    const raw = fs.readFileSync(CONTEXT_PATH, "utf8");
    const parsed = parseLatest(raw);
    if (!parsed) return null;
    const macroView = classifyMacroFromTags(parsed.tags ?? null);
    return { ...parsed, macro_view: macroView };
  } catch (err) {
    console.error(
      "[world] loadLatestWorldContext failed:",
      err?.message ?? err
    );
    return null;
  }
}
