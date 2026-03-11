// world/shadowObserver.js
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { promisify } from "util";

const API_KEY = process.env.GOOGLE_GENAI_API_KEY;
const MODEL_NAME = "gemini-3-flash-preview";
const CONTEXT_PATH = path.join(process.cwd(), "data", "world-context.jsonl");
const DB_PATH = path.join(process.cwd(), "data", "steward.db");

/**
 * Institutional Intelligence: Fetch a performance digest from SQLite
 */
async function getHistoricalPerformance() {
  if (!fs.existsSync(DB_PATH)) return "No historical database found yet.";
  
  const db = new sqlite3.Database(DB_PATH);
  const all = promisify(db.all).bind(db);

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

    db.close();

    let digest = "Internal Audit (Last 7 Days):\n";
    digest += actions.map(a => `- ${a.action_type}: ${a.count}`).join("\n");
    if (panics.length) {
        digest += "\nRecent Risk Events:\n";
        digest += panics.map(p => `- ${p.symbol} triggered ${p.reason_code} at ${p.timestamp}`).join("\n");
    }
    return digest;
  } catch (err) {
    db.close();
    return "Could not retrieve internal audit data.";
  }
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

async function callGemini({ systemInstruction, input, useSearch = true }) {
  const client = new GoogleGenAI({ apiKey: API_KEY });
  const config = {
    model: MODEL_NAME,
    system_instruction: systemInstruction,
    input: input,
  };
  if (useSearch) {
    config.tools = [{ type: "google_search" }];
  }

  const interaction = await client.interactions.create(config);
  let responseText = interaction.outputs[interaction.outputs.length - 1].text;
  
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
    const ageMs = Date.now() - Date.parse(latest.scout_generated_at);
    if (ageMs / (1000 * 60) < 15) {
      console.log(`[scout] Using cached successful analysis (age=${(ageMs/60000).toFixed(1)}m)`);
      return { ...latest, scout_cached: true };
    }
  }

  if (!API_KEY) return { scout_score: null, scout_label: "n/a", scout_thesis: "Gemini API key missing.", scout_tags: {} };

  const internalAudit = await getHistoricalPerformance();
  const systemInstruction = `
You are the "Elite Institutional Macro Scout" for Value Steward. 
Persona: Cynical quant analyst at a major hedge fund. 
Goal: Capital preservation and identifying "Tail Risk."

Core Mandates:
1. Data over Hype: Look for institutional moves and fundamental shifts.
2. Self-Awareness: Use the provided Internal Audit data.
3. Probability-Based Thinking: Think in terms of "Regime Shifts."

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

  const input = `Current Date: ${baseContext.date}. 
Analyze current global sentiment. 
RSS Headlines: ${baseContext.summary || "No specific headlines."}`;

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
