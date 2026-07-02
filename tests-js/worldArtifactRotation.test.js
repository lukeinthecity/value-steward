import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function importModule() {
  const moduleUrl = `${pathToFileURL(
    path.join(repoRoot, "core", "worldArtifactRotation.js")
  ).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

const NOW = new Date("2026-07-02T12:00:00Z");

test("rotateJsonlByAge splits on the boundary and keeps undated entries", async () => {
  const { rotateJsonlByAge } = await importModule();
  const entries = [
    { ts: "2026-07-01T12:00:00Z", id: "fresh" },
    { ts: "2026-06-02T11:59:00Z", id: "stale" }, // 30d + 1min old
    { ts: "2026-06-02T12:01:00Z", id: "boundary-keep" }, // just inside
    { id: "undated" },
    { ts: "not-a-date", id: "unparseable" },
  ];
  const { kept, trimmed } = rotateJsonlByAge(entries, {
    retainDays: 30,
    now: NOW,
  });
  assert.deepEqual(
    trimmed.map((e) => e.id),
    ["stale"]
  );
  assert.deepEqual(
    kept.map((e) => e.id),
    ["fresh", "boundary-keep", "undated", "unparseable"]
  );
});

test("refuses to rotate anything outside the allowlist", async () => {
  const { rotateWorldArtifact } = await importModule();
  for (const fileName of [
    "signal-scorecard.jsonl",
    "training-log.jsonl",
    "history.jsonl",
    "intent_log.jsonl",
    "world-context.jsonl",
  ]) {
    assert.throws(
      () => rotateWorldArtifact({ fileName, retainDays: 30 }),
      /Refusing to rotate/,
      fileName
    );
  }
});

function setupTmpCwd(t) {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-world-rotate-"));
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  return tmpDir;
}

function writeJsonlFile(filePath, entries) {
  fs.writeFileSync(
    filePath,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
}

test("rotation archives trimmed entries before truncating, idempotently", async (t) => {
  const { rotateWorldArtifact } = await importModule();
  const tmpDir = setupTmpCwd(t);
  const filePath = path.join(tmpDir, "data", "world-inbox.jsonl");
  writeJsonlFile(filePath, [
    { ts: "2026-07-01T12:00:00Z", id: "fresh" },
    { ts: "2026-05-01T12:00:00Z", id: "old-1" },
    { ts: "2026-04-01T12:00:00Z", id: "old-2" },
  ]);

  const first = rotateWorldArtifact({
    fileName: "world-inbox.jsonl",
    retainDays: 30,
    now: NOW,
  });
  assert.equal(first.kept, 1);
  assert.equal(first.trimmed, 2);
  assert.match(first.archive, /world-inbox-20260702\.jsonl$/);

  const workingLines = fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    workingLines.map((e) => e.id),
    ["fresh"]
  );
  const archiveLines = fs
    .readFileSync(first.archive, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    archiveLines.map((e) => e.id),
    ["old-1", "old-2"]
  );

  // Second run trims nothing and writes no new archive.
  const second = rotateWorldArtifact({
    fileName: "world-inbox.jsonl",
    retainDays: 30,
    now: NOW,
  });
  assert.equal(second.trimmed, 0);
  assert.equal(second.archive, null);
});

test("hydrated retention clamps up to at least inbox retention", async (t) => {
  const { runWorldArtifactRotation } = await importModule();
  const tmpDir = setupTmpCwd(t);
  // 40-day-old entry in both files; inbox retention 50 forces hydrated
  // (configured shorter at 45… here 10) up to 50 → entry kept everywhere.
  writeJsonlFile(path.join(tmpDir, "data", "world-inbox.jsonl"), [
    { ts: "2026-05-23T12:00:00Z", id: "mid-age" },
  ]);
  writeJsonlFile(path.join(tmpDir, "data", "world-hydrated.jsonl"), [
    { ts: "2026-05-23T12:00:00Z", id: "mid-age" },
  ]);

  const prevInbox = process.env.WORLD_INBOX_RETAIN_DAYS;
  const prevHydrated = process.env.WORLD_HYDRATED_RETAIN_DAYS;
  process.env.WORLD_INBOX_RETAIN_DAYS = "50";
  process.env.WORLD_HYDRATED_RETAIN_DAYS = "10";
  t.after(() => {
    if (prevInbox === undefined) delete process.env.WORLD_INBOX_RETAIN_DAYS;
    else process.env.WORLD_INBOX_RETAIN_DAYS = prevInbox;
    if (prevHydrated === undefined)
      delete process.env.WORLD_HYDRATED_RETAIN_DAYS;
    else process.env.WORLD_HYDRATED_RETAIN_DAYS = prevHydrated;
  });

  const results = runWorldArtifactRotation({ now: NOW });
  const hydrated = results.find((r) => r.file === "world-hydrated.jsonl");
  assert.equal(hydrated.trimmed, 0); // clamped to 50d, entry is 40d old
});

test("missing files degrade to a no-op", async (t) => {
  const { runWorldArtifactRotation } = await importModule();
  setupTmpCwd(t);
  const results = runWorldArtifactRotation({ now: NOW });
  assert.deepEqual(
    results.map((r) => ({ kept: r.kept, trimmed: r.trimmed })),
    [
      { kept: 0, trimmed: 0 },
      { kept: 0, trimmed: 0 },
    ]
  );
});
