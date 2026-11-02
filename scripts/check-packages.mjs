import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJSON = path => JSON.parse(readFileSync(path, "utf8"));
const workspace = readJSON(join(root, "package.json"));
assert.equal(workspace.private, true, "The workspace root must remain private.");
assert.deepEqual(workspace.workspaces, ["packages/*"]);
const hostLibraries = new Set([
  "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typebox",
]);
for (const [name, version] of Object.entries(workspace.devDependencies ?? {})) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `Pin development dependency ${name} exactly.`);
}
const names = new Set();
let count = 0;
for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(root, "packages", entry.name);
  const pkg = readJSON(join(dir, "package.json"));
  assert.equal(pkg.private, true, `${entry.name} must remain private.`);
  assert.match(pkg.name, /^@alexcarol\/pi-[a-z0-9-]+$/);
  assert.ok(!names.has(pkg.name), `Duplicate package name: ${pkg.name}`);
  names.add(pkg.name);
  assert.equal(pkg.type, "module");
  assert.match(pkg.version, /^0\.\d+\.\d+(?:-[\w.-]+)?$/, `${pkg.name} is experimental and must stay below 1.0.0.`);
  assert.match(readFileSync(join(dir, "README.md"), "utf8"), /\*\*Experimental\b/, `${pkg.name} README needs an experimental notice.`);
  assert.equal(pkg.repository?.directory, `packages/${entry.name}`);
  assert.ok(pkg.scripts?.test, `${pkg.name} needs a test script.`);
  assert.ok(pkg.pi && typeof pkg.pi === "object", `${pkg.name} needs an explicit Pi manifest.`);
  let resources = 0;
  for (const kind of ["extensions", "skills", "prompts", "themes"]) {
    if (pkg.pi[kind] === undefined) continue;
    assert.ok(Array.isArray(pkg.pi[kind]));
    for (const resource of pkg.pi[kind]) {
      assert.equal(typeof resource, "string");
      assert.ok(!/[*!?]/.test(resource), "Use explicit resource paths, not broad globs.");
      const path = resolve(dir, resource);
      const rel = relative(realpathSync(dir), realpathSync(path));
      assert.ok(rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep), "Resources must stay inside their package.");
      resources++;
    }
  }
  assert.ok(resources > 0, `${pkg.name} must declare at least one resource.`);
  for (const kind of ["dependencies", "optionalDependencies"]) {
    for (const dependency of Object.keys(pkg[kind] ?? {})) {
      assert.ok(!hostLibraries.has(dependency), `${dependency} belongs in peerDependencies, not ${kind}.`);
    }
  }
  for (const [dependency, version] of Object.entries(pkg.peerDependencies ?? {})) {
    if (hostLibraries.has(dependency)) assert.equal(version, "*", "Pi supplies the runtime host libraries.");
  }
  for (const file of ["README.md", "src", "test"]) assert.ok(existsSync(join(dir, file)), `${pkg.name} is missing ${file}.`);
  count++;
}
assert.ok(count > 0, "At least one add-on is required.");
console.log(`Validated ${count} private, experimental, independently installable Pi package(s).`);
