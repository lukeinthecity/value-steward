const FRAMES = ["|", "/", "-", "\\"];
const BAR_WIDTH = 18;

function shouldAnimate() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

function formatBar(percent, frameIndex) {
  if (percent === null) {
    const pos = frameIndex % BAR_WIDTH;
    const left = "=".repeat(pos);
    const right = "-".repeat(Math.max(0, BAR_WIDTH - pos - 1));
    return `[${left}>${right}] ??%`;
  }
  const safePercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((safePercent / 100) * BAR_WIDTH);
  const bar = `${"=".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}`;
  return `[${bar}] ${safePercent}%`;
}

export function startSpinner(label, options = {}) {
  let total = Number.isFinite(options.total) ? Math.max(0, options.total) : null;
  let current = 0;

  const getPercent = () => {
    if (!total) return null;
    const pct = Math.round((current / total) * 100);
    return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null;
  };

  const update = (value) => {
    if (Number.isFinite(value)) current = value;
  };

  const setTotal = (value) => {
    if (Number.isFinite(value)) total = Math.max(0, value);
  };

  if (!shouldAnimate()) {
    console.log(`[world] ${label}...`);
    const stop = (finalText = "") => {
      const percent = getPercent();
      const bar = formatBar(percent, 0);
      const suffix = finalText ? ` ${finalText}` : "";
      console.log(`[world] ${label} done ${bar}.${suffix}`);
    };
    stop.update = update;
    stop.setTotal = setTotal;
    return stop;
  }

  let idx = 0;
  const timer = setInterval(() => {
    const frame = FRAMES[idx % FRAMES.length];
    const percent = getPercent();
    const bar = formatBar(percent, idx);
    idx += 1;
    process.stdout.write(`\r${frame} ${label} ${bar}`);
  }, 120);

  const stop = (finalText = "") => {
    clearInterval(timer);
    current = total ?? current;
    const bar = formatBar(getPercent(), idx);
    const suffix = finalText ? ` ${finalText}` : "";
    process.stdout.write(`\r\u2713 ${label} ${bar}${suffix}\n`);
  };
  stop.update = update;
  stop.setTotal = setTotal;
  return stop;
}
