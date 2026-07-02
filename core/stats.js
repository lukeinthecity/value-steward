/**
 * Small statistics helpers for the observation/reporting modules.
 *
 * Deliberately NOT used by the decision-path trainers (signalWeightTrainer,
 * oosEvaluator keep their inline math) — refactoring those mid-run is
 * regression risk for no behavior gain. Consider unifying post-run.
 */

export function mean(values) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function median(values) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function sampleStd(values) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const m = mean(nums);
  const variance =
    nums.reduce((acc, v) => acc + (v - m) * (v - m), 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

/**
 * One-sample t-statistic against zero: mean / (std / sqrt(n)).
 * Null when n < 2 or the spread is zero.
 */
export function tStatVsZero(values) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const std = sampleStd(nums);
  if (!std) return null;
  return mean(nums) / (std / Math.sqrt(nums.length));
}

/**
 * Welch's two-sample t-statistic (unequal variances): positive when
 * group A's mean exceeds group B's. Null unless both groups have n >= 2
 * and at least one has spread.
 */
export function welchTStat(a, b) {
  const numsA = (a ?? []).filter((v) => Number.isFinite(v));
  const numsB = (b ?? []).filter((v) => Number.isFinite(v));
  if (numsA.length < 2 || numsB.length < 2) return null;
  const varA = sampleStd(numsA) ** 2;
  const varB = sampleStd(numsB) ** 2;
  const denom = Math.sqrt(varA / numsA.length + varB / numsB.length);
  if (!denom) return null;
  return (mean(numsA) - mean(numsB)) / denom;
}
