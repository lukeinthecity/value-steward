import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function resolvePath(filePath) {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(REPO_ROOT, filePath);
  
  if (!abs.startsWith(REPO_ROOT)) {
    throw new Error(`Security Error: Path traversal attempt blocked: ${filePath}`);
  }
  return abs;
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
