// world/shadowObserver.js
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import { buildDailyPromotionSnapshot } from "../core/promotionMetrics.js";
import {
  loadLatestTrainingEntry,
  loadLatestTickSnapshot,
  loadPolicySnapshot,
  loadPortfolioLiveSnapshot,
} from "../core/runtimeArtifacts.js";

const API_KEY = process.env.GOOGLE_GENAI_API_KEY;
const MODEL_NAME = "gemini-3-flash-preview";
const CONTEXT_PATH = path.join(process.cwd(), "data", "world-context.jsonl");
const DB_PATH = path.join(process.cwd(), "data", "steward.db");
const SCORECARD_PATH = path.join(process.cwd(), "data", "signal-scorecard.jsonl");
const PATTERNS_PATH = path.join(process.cwd(), "data", "patterns.jsonl");
const INTENT_LOG_PATH = path.join(process.cwd(), "logs", "intent_log.jsonl");

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function pct(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function summarizeRecentIntents() {
  const intents = loadJsonl(INTENT_LOG_PATH);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = intents.filter((entry) => Date.parse(entry.timestamp) >= cutoff);
  if (!recent.length) {
    return "Recent Intent Summary:\n- No recent intents found.";
  }

  const actionCounts = {};
  const reasonCounts = {};
  recent.forEach((entry) => {
    const action = entry.action_type || "UNKNOWN";
    actionCounts[action] = (actionCounts[action] || 0) + 1;
    if (entry.reason_code) {
      reasonCounts[entry.reason_code] = (reasonCounts[entry.reason_code] || 0) + 1;
    }
  });
  const topReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `- ${reason}: ${count}`);

  let digest = "Recent Intent Summary (Last 7 Days):\n";
  digest += Object.entries(actionCounts)
    .map(([action, count]) => `- ${action}: ${count}`)
    .join("\n");
  if (topReasons.length) {
    digest += "\nTop Decision Reasons:\n";
    digest += topReasons.join("\n");
  }
  return digest;
}

function summarizeScorecard() {
  const records = loadJsonl(SCORECARD_PATH);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = records.filter((entry) => Date.parse(entry.timestamp) >= cutoff);
  if (!recent.length) {
    return "Scorecard Snapshot:\n- No recent scorecard records.";
  }

  const oneDay = recent
    .map((entry) => entry.horizons?.["1"])
    .filter(Boolean);
  const avgExcessBenchmark = average(
    oneDay.map((entry) => Number(entry.excess_vs_benchmark))
  );
  const avgExcessCash = average(
    oneDay.map((entry) => Number(entry.excess_vs_cash))
  );
  const buyRecords = recent.filter((entry) =>
    ["BUY", "MULTI"].includes(entry.action_type)
  );
  const noActionRecords = recent.filter((entry) => entry.action_type === "NO_ACTION");

  return [
    "Scorecard Snapshot (Last 7 Days):",
    `- Records: ${recent.length}`,
    `- BUY records: ${buyRecords.length}`,
    `- NO_ACTION records: ${noActionRecords.length}`,
    `- Avg 1D excess vs benchmark: ${pct(avgExcessBenchmark)}`,
    `- Avg 1D excess vs cash: ${pct(avgExcessCash)}`,
  ].join("\n");
}

function summarizePatterns() {
  const patterns = loadJsonl(PATTERNS_PATH)
    .filter((entry) => entry.status === "active")
    .sort((a, b) => (b.sample_size || 0) - (a.sample_size || 0))
    .slice(0, 3);
  if (!patterns.length) {
    return "Pattern Library:\n- No active learned patterns yet.";
  }
  return [
    "Pattern Library:",
    ...patterns.map(
      (pattern) =>
        `- ${pattern.pattern_id}: samples=${pattern.sample_size} avg_return=${pct(
          Number(pattern.avg_return)
        )} max_drawdown=${pct(Number(pattern.max_drawdown))}`
    ),
  ].join("\n");
}

function summarizeTrainingAndPolicy() {
  const training = loadLatestTrainingEntry();
  const policy = loadPolicySnapshot();
  const capSummary = [
    `max_effective_capital_dollars=${policy?.max_effective_capital_dollars ?? process.env.MAX_EFFECTIVE_CAPITAL_DOLLARS ?? "n/a"}`,
    `max_trade_notional_dollars=${policy?.max_trade_notional_dollars ?? process.env.MAX_TRADE_NOTIONAL_DOLLARS ?? "n/a"}`,
    `min_trade_notional_dollars=${policy?.min_trade_notional_dollars ?? process.env.MIN_TRADE_NOTIONAL_DOLLARS ?? "n/a"}`,
  ].join(", ");

  return [
    "Training & Policy:",
    `- Policy version: ${policy?.version ?? "n/a"} mode=${policy?.mode ?? "n/a"} risk_level=${policy?.risk_level ?? "n/a"}`,
    `- Capital rails: ${capSummary}`,
    `- Last training decision: ${training?.decision ?? "n/a"} reason=${training?.reason ?? "n/a"}`,
    `- Last training policy change: ${training?.policyVersionBefore ?? "n/a"} -> ${training?.policyVersionAfter ?? training?.policyVersion ?? "n/a"}`,
  ].join("\n");
}

function summarizeLatestArtifacts() {
  const latestTick = loadLatestTickSnapshot();
  const portfolio = loadPortfolioLiveSnapshot();
  const worldContexts = loadJsonl(CONTEXT_PATH);
  const world = worldContexts.length ? worldContexts[worldContexts.length - 1] : null;

  const tickPositions = Array.isArray(latestTick?.result?.positions)
    ? latestTick.result.positions.length
    : 0;
  const portfolioPositions = Array.isArray(portfolio?.positions)
    ? portfolio.positions.length
    : 0;

  return [
    "Latest Cycle Artifacts:",
    `- Latest tick: ${latestTick?.generated_at ?? latestTick?.result?.ranAt ?? "n/a"} exchange_date=${latestTick?.exchange_date ?? "n/a"} positions=${tickPositions}`,
    `- Portfolio refresh: ${portfolio?.updated_at ?? portfolio?.snapshot?.timestamp ?? "n/a"} positions=${portfolioPositions}`,
    `- World context: ${world?.generated_at ?? "n/a"} date=${world?.date ?? "n/a"} slot=${world?.slot ?? "n/a"}`,
    `- Massive macro: ${world?.massive_macro_summary ?? "n/a"}`,
  ].join("\n");
}

/**
 * Institutional Intelligence: Fetch a performance digest from SQLite
 */
async function getHistoricalPerformance() {
  if (!fs.existsSync(DB_PATH)) return "No historical database found yet.";
  
  const db = new sqlite3.Database(DB_PATH);
  const all = promisify(db.all).bind(db);
  const close = promisify(db.close).bind(db);

  try {
    const actions = await all(`
      SELECT action_type, count(*) as count 
      FROM intents 
      WHERE timestamp > datetime('now', '-7 days')
      GROUP BY action_type
    `);
    
    const panics = await all(`
      SELECT symbol, timestamp, reason_code 
      FROM intents 
      WHERE reason_code IN ('VOL_STOP', 'DAILY_LOSS_LIMIT')
      ORDER BY timestamp DESC LIMIT 3
    `);

    await close();

    let digest = "Internal Audit (Last 7 Days):\n";
    digest += actions.map(a => `- ${a.action_type}: ${a.count}`).join("\n");
    if (panics.length) {
        digest += "\nRecent Risk Events:\n";
        digest += panics.map(p => `- ${p.symbol} triggered ${p.reason_code} at ${p.timestamp}`).join("\n");
    }
    return digest;
  } catch (err) {
    await close().catch(() => {});
    return "Could not retrieve internal audit data.";
  }
}

export async function buildScoutAuditPacket() {
  const sections = [];
  sections.push(await getHistoricalPerformance());
  sections.push(summarizeRecentIntents());
  sections.push(summarizeScorecard());
  sections.push(summarizePatterns());
  sections.push(summarizeTrainingAndPolicy());
  sections.push(summarizeLatestArtifacts());

  try {
    const promotion = await buildDailyPromotionSnapshot();
    sections.push(
      [
        "Promotion & Integrity:",
        `- Stage: ${promotion.stage}`,
        `- Verdict: ${promotion.verdict}`,
        `- Blockers: ${promotion.blockers.length ? promotion.blockers.join(", ") : "none"}`,
        `- Integrity pass: ${promotion.integrity?.pass ?? "n/a"}`,
        `- Cap compliance pass: ${promotion.cap_compliance?.pass ?? "n/a"}`,
        `- Reconciliation pass: ${promotion.reconciliation?.pass ?? "n/a"}`,
      ].join("\n")
    );
  } catch {
    sections.push("Promotion & Integrity:\n- Unavailable.");
  }

  return sections.filter(Boolean).join("\n\n");
}

export function buildScoutSystemInstruction({ internalAudit }) {
  return `
You are the "Elite Institutional Macro Scout" for Value Steward.
Persona: Cynical quant analyst at a major hedge fund.
Role: Advisory macro scout. You do not place trades and you do not control sizing directly.

Primary Mission:
- Protect capital first.
- Detect regime shifts, tail risks, fragility, and false confidence.
- Surface when the system should become more cautious, not more aggressive.

Operating Context:
- Value Steward is in a small-capital apprenticeship phase.
- The system is intentionally trading tiny amounts to earn the right to scale.
- Operational integrity, truthful reporting, and bounded risk matter more than upside capture.
- A false-positive "all clear" is more damaging than a missed opportunity.

Focus Rules:
1. Data over Hype: Look for institutional moves, macro fractures, funding stress, and real regime change.
2. Self-Awareness: Use the provided Internal Audit data as context for recent behavior and fragility.
3. Ground Truth: Analyze the provided source excerpts for nuance not visible in headlines.
4. Probability-Based Thinking: Think in distributions, scenarios, and regime shifts, not certainties.
5. Uncertainty Discipline: If evidence is mixed, stale, or low-confidence, lean more cautious and say so plainly.
6. Do Not Game Metrics: Do not optimize for "promotion", "scaling", or making the system look ready. Your job is honest risk interpretation.

Internal Context: ${internalAudit}

Output a raw JSON object ONLY.
Structure: {
  "scout_score": 0.0-1.0,
  "scout_label": "calm"|"watchful"|"stressed"|"crisis-prone",
  "scout_thesis": "2-sentence summary",
  "scout_headlines": ["head 1", "head 2", "head 3"],
  "scout_tags": { "macro_risk": 0.0-1.0, "rate_hawkishness": 0.0-1.0, "geopolitical_tension": 0.0-1.0, "energy_shock_risk": 0.0-1.0, "recession_fear": 0.0-1.0 }
}
`;
}

function loadLatestEntry() {
  try {
    if (!fs.existsSync(CONTEXT_PATH)) return null;
    const raw = fs.readFileSync(CONTEXT_PATH, "utf8").trim();
    if (!raw) return null;
    const lines = raw.split("\n").filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch (err) {
    return null;
  }
}

function extractCachedScoutFields(entry) {
  return {
    scout_score: entry?.scout_score ?? null,
    scout_label: entry?.scout_label ?? "n/a",
    scout_thesis: entry?.scout_thesis ?? null,
    scout_headlines: Array.isArray(entry?.scout_headlines)
      ? entry.scout_headlines
      : [],
    scout_tags:
      entry && typeof entry.scout_tags === "object" && entry.scout_tags !== null
        ? entry.scout_tags
        : {},
    scout_generated_at: entry?.scout_generated_at ?? null,
    scout_method: entry?.scout_method ?? "cache",
  };
}

async function callGemini({ systemInstruction, input, useSearch = true }) {
  const client = new GoogleGenAI({ apiKey: API_KEY });
  // Stable generateContent API (the experimental Interactions API was
  // deprecated by Google in May 2026). Grounding tool format also changed:
  // { type: "google_search" } -> { googleSearch: {} }.
  const config = { systemInstruction };
  if (useSearch) {
    config.tools = [{ googleSearch: {} }];
  }

  const response = await client.models.generateContent({
    model: MODEL_NAME,
    contents: input,
    config,
  });
  let responseText = response.text;
  if (!responseText) {
    throw new Error("Gemini returned no text content.");
  }

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) responseText = jsonMatch[0];
  return JSON.parse(responseText);
}

/**
 * The Shadow Observer (Scout) uses Gemini + Google Search 
 * + Internal Database Audit to provide high-fidelity insights.
 */
export async function observeWorld({ baseContext }) {
  const latest = loadLatestEntry();
  
  // 15-minute success cache
  if (latest && latest.scout_score !== null && latest.scout_generated_at) {
    const generatedAt = Date.parse(latest.scout_generated_at);
    const ageMs = Number.isFinite(generatedAt) ? Date.now() - generatedAt : Infinity;
    if (ageMs / (1000 * 60) < 15) {
      console.log(`[scout] Using cached successful analysis (age=${(ageMs/60000).toFixed(1)}m)`);
      return { ...extractCachedScoutFields(latest), scout_cached: true };
    }
  }

  if (!API_KEY) return { scout_score: null, scout_label: "n/a", scout_thesis: "Gemini API key missing.", scout_tags: {} };

  const internalAudit = await buildScoutAuditPacket();
  const systemInstruction = buildScoutSystemInstruction({ internalAudit });

  let input = `Current Date: ${baseContext.date}. \nAnalyze current global sentiment.\n`;
  input += `Headlines & Macro: ${baseContext.summary || "No specific headlines."}\n\n`;
  input += `Massive Macro Snapshot: ${baseContext.massive_macro_summary || "Unavailable"}\n\n`;
  
  if (baseContext.corpus_preview && baseContext.corpus_preview.length) {
    input += `Source Ground Truth (Recent Article Excerpts):\n`;
    baseContext.corpus_preview.forEach((p, i) => {
      input += `[${i+1}] ${p.title} (${p.source_id}): ${p.excerpt}\n`;
    });
  }

  console.log(`[scout] Calling Gemini API (Tier 1: Search) for ${baseContext.date}...`);
  try {
    const result = await callGemini({ systemInstruction, input, useSearch: true });
    console.log(`[scout] Tier 1 Success: ${result.scout_label}`);
    return { ...result, scout_generated_at: new Date().toISOString(), scout_method: "search" };
  } catch (err) {
    if (err.message.includes("429") || err.message.includes("quota")) {
        console.warn("[scout] Tier 1 Quota Hit. Falling back to Tier 2 (No Search)...");
        try {
            const result = await callGemini({ systemInstruction, input, useSearch: false });
            console.log(`[scout] Tier 2 Success: ${result.scout_label}`);
            return { ...result, scout_generated_at: new Date().toISOString(), scout_method: "base" };
        } catch (err2) {
            return { 
                scout_score: null, scout_label: "resting", 
                scout_thesis: "AI Scout is resting to respect API quotas. Guardian logic active.",
                scout_headlines: [], scout_tags: {}, scout_generated_at: new Date().toISOString()
            };
        }
    }
    return { scout_score: null, scout_label: "error", scout_thesis: `Gemini Error: ${err.message}`, scout_headlines: [], scout_tags: {} };
  }
}

if (process.argv[1].endsWith("shadowObserver.js")) {
    observeWorld({ baseContext: { date: new Date().toISOString().slice(0, 10), summary: "Markets waiting for CPI data." } }).then(res => {
        console.log(JSON.stringify(res, null, 2));
    });
}
