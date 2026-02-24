import fs from "fs/promises";
import path from "path";

function resolvePath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
}

export async function loadJsonFile({ path: filePath, defaultValue }) {
  const abs = resolvePath(filePath);
  try {
    const raw = await fs.readFile(abs, "utf8");
    return { content: JSON.parse(raw) };
  } catch (err) {
    return { content: defaultValue };
  }
}

export async function saveJsonFile({ path: filePath, content }) {
  const abs = resolvePath(filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(content, null, 2));
}

export async function appendJsonl({ path: filePath, entry }) {
  const abs = resolvePath(filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(abs, line, "utf8");
}
