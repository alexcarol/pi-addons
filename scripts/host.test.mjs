import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Pi discovers the packaged extensions globally from two unrelated projects", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-addons-host-"));
  const oldLog = process.env.PI_SKILL_LOG;
  const oldCatalog = process.env.PI_SKILL_CATALOG_DIR;
  process.env.PI_SKILL_LOG = join(temp, "usage.jsonl");
  process.env.PI_SKILL_CATALOG_DIR = join(temp, "catalog");
  try {
    const agentDir = join(temp, "agent");
    const globalExtensions = join(agentDir, "extensions");
    mkdirSync(globalExtensions, { recursive: true });
    let expected = 0;
    for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = join(root, "packages", entry.name);
      const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
      if (!pkg.pi?.extensions?.length) continue;
      const target = join(globalExtensions, entry.name);
      mkdirSync(target);
      // Use only package payload files, so the smoke test catches missing runtime assets.
      for (const path of ["package.json", ...pkg.files]) {
        cpSync(join(source, path), join(target, path), { recursive: true });
      }
      expected += pkg.pi.extensions.length;
    }
    for (const project of ["project-a", "project-b"]) {
      const cwd = join(temp, project);
      mkdirSync(cwd);
      const result = await discoverAndLoadExtensions([], cwd, agentDir);
      assert.deepEqual(result.errors, []);
      assert.equal(result.extensions.length, expected);
      const tracker = result.extensions.filter(extension =>
        extension.resolvedPath === join(globalExtensions, "skill-tracker", "src", "index.ts"));
      assert.equal(tracker.length, 1, "The tracker must load exactly once.");
      assert.deepEqual([...tracker[0].commands.keys()].sort(), ["skill-doctor", "skill-stats"]);
      const commands = result.extensions.flatMap(extension => [...extension.commands.keys()]);
      assert.equal(new Set(commands).size, commands.length, "Global commands must not collide.");
    }
  } finally {
    if (oldLog === undefined) delete process.env.PI_SKILL_LOG;
    else process.env.PI_SKILL_LOG = oldLog;
    if (oldCatalog === undefined) delete process.env.PI_SKILL_CATALOG_DIR;
    else process.env.PI_SKILL_CATALOG_DIR = oldCatalog;
    rmSync(temp, { recursive: true, force: true });
  }
});
