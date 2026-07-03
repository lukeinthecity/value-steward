/**
 * Phase-run reset (Run 1 → Run 2 was PR #17 done by hand; this makes the
 * procedure repeatable and reviewable).
 *
 * A reset archives every learning artifact, truncates it, wipes the LEARNED
 * policy blocks (weights, posteriors, champion) back to baseline, and moves
 * phase1_start_date — so the next run's evidence is attributable to exactly
 * one policy lineage from Day 1. Operator-configured fields (caps, risk
 * targets, buffers) are preserved.
 *
 * Nothing is destroyed: artifacts are copied to data/archive/<label>/ and
 * logs/archive/<label>/ (both gitignored) before truncation.
 */

import fs from "fs";
import path from "path";

import { normalizePolicySnapshot } from "./policySnapshot.js";
import { writeJsonAtomic } from "./runtimeArtifacts.js";
import { updateStateSync } from "./stewardState.js";

const DATA_ARTIFACTS = [
  "signal-scorecard.jsonl",
  "training-log.jsonl",
  "history.jsonl",
  "oos-eval.jsonl",
  "intraday-observations.jsonl",
  "execution-quality.jsonl",
  "patterns.jsonl",
  "scorecard-summary.json",
  "scorecard-summary.jsonl",
  "latest-tick.json",
  "eod-state.json",
  "execution-state.json",
];
const LOG_ARTIFACTS = ["intent_log.jsonl", "intent_outcomes.jsonl"];

function validateArgs({ runLabel, startDate }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(runLabel ?? ""))) {
    throw new Error(`invalid run label: ${runLabel}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate ?? ""))) {
    throw new Error(`invalid start date (want YYYY-MM-DD): ${startDate}`);
  }
}

function artifactMoves(runLabel) {
  const moves = [];
  for (const name of DATA_ARTIFACTS) {
    moves.push({
      from: path.join(process.cwd(), "data", name),
      to: path.join(process.cwd(), "data", "archive", runLabel, name),
    });
  }
  for (const name of LOG_ARTIFACTS) {
    moves.push({
      from: path.join(process.cwd(), "logs", name),
      to: path.join(process.cwd(), "logs", "archive", runLabel, name),
    });
  }
  return moves.filter((move) => fs.existsSync(move.from));
}

function buildResetPolicy(policy, { runLabel, nowIso }) {
  const reset = {
    ...policy,
    version: 1,
    signal_weights: {},
    score_gate_posteriors: {},
    lastTrainedAt: nowIso,
    lastTrainingReason: `phase1_${runLabel}_reset`,
  };
  delete reset.score_gate_posteriors_meta;
  return normalizePolicySnapshot(reset);
}

function buildStatePatch(startDate) {
  return {
    phase1_start_date: startDate,
    phase1_milestones_sent: [],
    phase1_ready_notified: false,
    executions_today: 0,
    last_executed_date: null,
    last_executed_at: null,
    last_eod_email_date: null,
  };
}

/**
 * What a reset WOULD do — used by the dry-run.
 */
export function planPhaseReset({ runLabel, startDate }) {
  validateArgs({ runLabel, startDate });
  const policyPath = path.join(process.cwd(), "config", "policy.json");
  return {
    run_label: runLabel,
    start_date: startDate,
    archives: artifactMoves(runLabel),
    policy_reset: fs.existsSync(policyPath),
    state_patch: buildStatePatch(startDate),
  };
}

/**
 * Execute the reset: archive → truncate → reset policy → patch state.
 * @param {object} args
 * @param {string} args.runLabel - e.g. "run3" (archive folder name).
 * @param {string} args.startDate - Day 1 of the new run, YYYY-MM-DD.
 * @param {Function} [args.applyStatePatch] - injectable for tests.
 */
export function executePhaseReset({
  runLabel,
  startDate,
  now = new Date(),
  applyStatePatch = (patch) =>
    updateStateSync((state) => ({ ...state, ...patch })),
} = {}) {
  const plan = planPhaseReset({ runLabel, startDate });
  const nowIso = now.toISOString();

  for (const move of plan.archives) {
    fs.mkdirSync(path.dirname(move.to), { recursive: true });
    fs.copyFileSync(move.from, move.to);
    fs.unlinkSync(move.from);
  }

  let policyReset = false;
  const policyPath = path.join(process.cwd(), "config", "policy.json");
  if (plan.policy_reset) {
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    writeJsonAtomic(policyPath, buildResetPolicy(policy, { runLabel, nowIso }));
    policyReset = true;
  }

  applyStatePatch(plan.state_patch);

  return {
    run_label: runLabel,
    start_date: startDate,
    archived: plan.archives.map((move) => move.from),
    policy_reset: policyReset,
    reason_code: "PHASE_RESET_EXECUTED",
    timestamp: nowIso,
  };
}

export const _internals = { buildResetPolicy, buildStatePatch };
