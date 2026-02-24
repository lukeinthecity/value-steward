const FRAMES = ["|", "/", "-", "\\"];

function shouldAnimate() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

export function startSpinner(label) {
  const start = Date.now();
  if (!shouldAnimate()) {
    console.log(`[world] ${label}...`);
    return (finalText = "") => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const suffix = finalText ? ` ${finalText}` : "";
      console.log(`[world] ${label} done (${elapsed}s).${suffix}`);
    };
  }

  let idx = 0;
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const frame = FRAMES[idx % FRAMES.length];
    idx += 1;
    process.stdout.write(`\r${frame} ${label} (${elapsed}s)`);
  }, 120);

  return (finalText = "") => {
    clearInterval(timer);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const suffix = finalText ? ` ${finalText}` : "";
    process.stdout.write(`\r\u2713 ${label} (${elapsed}s)${suffix}\n`);
  };
}
