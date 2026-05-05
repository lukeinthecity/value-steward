import "dotenv/config";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { pathToFileURL } from "url";

import { appendIntradayObservation } from "../core/runtimeArtifacts.js";
import { getExchangeDateString, getExchangeTimeParts } from "../core/timeUtils.js";

function resolvePythonCommand() {
  const explicit = (process.env.VS_PYTHON || "").trim();
  if (explicit) return explicit;
  const venvPath = path.join(process.cwd(), ".venv", "bin", "python");
  if (fs.existsSync(venvPath)) return venvPath;
  return "python3";
}

function runPortfolioSnapshot(cycleId = null) {
  return new Promise((resolve, reject) => {
    const pythonCmd = resolvePythonCommand();
    const child = spawn(
      pythonCmd,
      ["-m", "valuesteward.cli", "portfolio", "--out", "data/portfolio-live.json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VS_ARTIFACT_CYCLE_ID: cycleId ?? "",
        },
        stdio: "ignore",
      }
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`portfolio snapshot failed with exit code ${code ?? 1}`));
      }
    });
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function runSignalSnapshot(outPath, limit = 5, cycleId = null) {
  return new Promise((resolve, reject) => {
    const pythonCmd = resolvePythonCommand();
    const child = spawn(
      pythonCmd,
      [
        "-m",
        "valuesteward.cli",
        "signal-snapshot",
        "--out",
        outPath,
        "--limit",
        String(limit),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VS_ARTIFACT_CYCLE_ID: cycleId ?? "",
        },
        stdio: "ignore",
      }
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`signal snapshot failed with exit code ${code ?? 1}`));
      }
    });
  });
}

function normalizeTopCandidates(signalSnapshot) {
  const generatedAt = signalSnapshot?.generated_at ?? null;
  return Array.isArray(signalSnapshot?.candidates)
    ? signalSnapshot.candidates.map((candidate) => ({
        timestamp: candidate?.timestamp ?? generatedAt,
        action_type: "CANDIDATE",
        symbol: candidate?.symbol ?? null,
        signal_score: candidate?.signal_score ?? null,
        signal_sector: candidate?.signal_sector ?? null,
        execution_quality_score: candidate?.execution_quality_score ?? null,
        intraday_persistence_score: candidate?.intraday_persistence_score ?? null,
        realized_alpha_prior: candidate?.realized_alpha_prior ?? null,
        world_regime_label: null,
        reason_code: "RANKED_SIGNAL",
      }))
    : [];
}

export function buildObservation({
  portfolio,
  latestTick,
  worldContext,
  signalSnapshot,
  now,
}) {
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const topCandidates = normalizeTopCandidates(signalSnapshot).slice(0, 5);
  const parts = getExchangeTimeParts(now);

  return {
    observed_at: now.toISOString(),
    exchange_date: getExchangeDateString(now),
    cycle_id:
      signalSnapshot?.cycle_id ??
      worldContext?.cycle_id ??
      latestTick?.cycle_id ??
      latestTick?.result?.cycle_id ??
      portfolio?.cycle_id ??
      null,
    exchange_time: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
    slot: "intraday_observation",
    account: {
      equity: portfolio?.account?.equity ?? latestTick?.result?.equity ?? null,
      cash: portfolio?.account?.cash ?? latestTick?.result?.cash ?? null,
      buying_power:
        portfolio?.account?.buying_power ?? latestTick?.result?.buyingPower ?? null,
      position_count:
        portfolio?.snapshot?.position_count ?? latestTick?.result?.numPositions ?? 0,
      gross_exposure:
        latestTick?.result?.grossExposure ??
        positions.reduce(
          (sum, position) => sum + Math.abs(Number(position.market_value ?? position.marketValue ?? 0)),
          0
        ),
    },
    positions: positions.map((position) => ({
      symbol: position.symbol,
      market_value: position.market_value ?? position.marketValue ?? null,
      quantity: position.quantity ?? position.qty ?? null,
    })),
    world: worldContext
      ? {
          generated_at: worldContext.generated_at ?? null,
          macro_label: worldContext.macro_view?.macro_label ?? null,
          macro_score: worldContext.macro_view?.macro_score ?? null,
          regime_label: worldContext.final_regime?.final_label ?? null,
          regime_score: worldContext.final_regime?.final_score ?? null,
          divergence: worldContext.final_regime?.divergence ?? null,
        }
      : null,
    top_candidates: topCandidates,
  };
}

async function main() {
  const now = new Date();
  const signalSnapshotPath = path.join(
    process.cwd(),
    "data",
    "intraday-signal-snapshot.json"
  );
  const worldContextPath = path.join(process.cwd(), "data", "world-context.jsonl");
  const worldLines = fs.existsSync(worldContextPath)
    ? fs.readFileSync(worldContextPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  const worldContext = worldLines.length
    ? JSON.parse(worldLines[worldLines.length - 1])
    : null;
  const cycleId = worldContext?.cycle_id ?? null;

  await runPortfolioSnapshot(cycleId);
  await runSignalSnapshot(signalSnapshotPath, 5, cycleId);

  const portfolio = readJson(path.join(process.cwd(), "data", "portfolio-live.json"));
  const latestTick = readJson(path.join(process.cwd(), "data", "latest-tick.json"));
  const signalSnapshot = readJson(signalSnapshotPath);

  const observation = buildObservation({
    portfolio,
    latestTick,
    worldContext,
    signalSnapshot,
    now,
  });
  appendIntradayObservation(observation);
  console.log(
    `[intraday] snapshot ${observation.exchange_date} ${observation.exchange_time} ` +
      `positions=${observation.account.position_count} candidates=${observation.top_candidates.length}`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((err) => {
    console.error("[intraday] observation failed:", err?.message ?? err);
    process.exit(1);
  });
}
