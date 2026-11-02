import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";

// Import only after overriding storage: tests must never touch real usage data.
const root = fs.mkdtempSync(join(tmpdir(), "pi-skill-tracker-test-"));
const originalLog = process.env.PI_SKILL_LOG;
const originalCatalog = process.env.PI_SKILL_CATALOG_DIR;
process.env.PI_SKILL_LOG = join(root, "usage.jsonl");
process.env.PI_SKILL_CATALOG_DIR = join(root, "catalog");
const { default: skillTracker } = await import("../src/index.ts");
const { LOG_PATH, CATALOG_DIR, readRecords } = await import("../src/report.ts");
const lockPath = `${LOG_PATH}.rotate.lock`;
const historical = {
	ts: "2026-10-01T00:00:00.000Z", skill: "historical-skill", via: "read",
	session: "historical-session", cwd: "/fixture/historical", pid: 0,
};

beforeEach(() => {
	mock.restoreAll();
	syncBuiltinESMExports();
	for (const path of [LOG_PATH, `${LOG_PATH}.1`, lockPath, CATALOG_DIR]) {
		fs.rmSync(path, { recursive: true, force: true });
	}
});

after(() => {
	mock.restoreAll();
	syncBuiltinESMExports();
	fs.rmSync(root, { recursive: true, force: true });
	if (originalLog === undefined) delete process.env.PI_SKILL_LOG;
	else process.env.PI_SKILL_LOG = originalLog;
	if (originalCatalog === undefined) delete process.env.PI_SKILL_CATALOG_DIR;
	else process.env.PI_SKILL_CATALOG_DIR = originalCatalog;
});

async function agent(name = "fixture-skill", session = "fixture-session") {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	skillTracker({
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand(command: string, options: any) { commands.set(command, options); },
	} as any);
	const skill = {
		name, description: "A descriptive fixture skill used only by the regression tests.",
		filePath: join(root, "skills", name, "SKILL.md"),
		baseDir: join(root, "skills", name), sourceInfo: { scope: "user" },
		disableModelInvocation: false,
	};
	const selections: Array<{ title: string; lines: string[] }> = [];
	const ctx = {
		cwd: join(root, session), model: { id: "fixture-model" },
		sessionManager: { getSessionId: () => session },
		getSystemPromptOptions: () => ({ skills: [skill] }),
		ui: {
			notify() {},
			async select(title: string, lines: string[]) {
				selections.push({ title, lines });
				return title === "skill-doctor"
					? lines.find(line => /^[✓·?]\s/.test(line)) : undefined;
			},
		},
	};
	await handlers.get("session_start")!({}, ctx);
	await handlers.get("before_agent_start")!({ systemPromptOptions: { skills: [skill] } }, ctx);
	return {
		ctx, skill, selections, commands,
		input: () => handlers.get("input")!({ text: `/skill:${name}` }, ctx),
		read: (path = skill.filePath) => handlers.get("tool_call")!({ toolName: "read", input: { path } }, ctx),
		bash: () => handlers.get("tool_call")!({ toolName: "bash", input: { command: `head '${skill.filePath}'` } }, ctx),
	};
}

function largeLog() {
	fs.writeFileSync(LOG_PATH, `${JSON.stringify(historical)}\n${" ".repeat(8 * 1024 * 1024)}`);
}

test("records commands, reads, resources and bash references without recording unrelated files", async () => {
	const a = await agent();
	await a.input();
	await a.read();
	await a.read(join(a.skill.baseDir, "references", "guide.md"));
	await a.bash();
	await a.read(join(root, "unrelated.md"));
	const records = readRecords();
	assert.deepEqual(records.map(record => record.via), ["command", "read", "resource", "bash"]);
	assert.ok(records.every(record => record.session === "fixture-session"));
});

for (const name of ["fixture-skill", "example-security-skills-example-security-foundations"]) {
	test(`menu selection opens details for ${name}`, async () => {
		const a = await agent(name);
		await a.commands.get("skill-doctor").handler("", a.ctx);
		assert.equal(a.selections.length, 2);
		assert.equal(a.selections[1].title, `skill-doctor: ${name}`);
	});
}

test("single-writer rotation preserves the previous log and the new record", async () => {
	const a = await agent();
	largeLog();
	await a.input();
	assert.deepEqual(readRecords().map(record => record.session), ["historical-session", "fixture-session"]);
	assert.equal(fs.existsSync(lockPath), false);
});

test("overlapping rotation checks do not replace the historical archive with a new small log", async () => {
	const a = await agent("fixture-skill", "writer-a");
	const b = await agent("fixture-skill", "writer-b");
	largeLog();
	const stat = fs.statSync;
	let injected = false;
	let pending: Promise<unknown> | undefined;
	mock.method(fs, "statSync", ((path: any, options: any) => {
		const snapshot = stat(path, options);
		if (String(path) === LOG_PATH && !injected) {
			injected = true;
			pending = b.input();
		}
		return snapshot;
	}) as any);
	syncBuiltinESMExports();
	try {
		await a.input();
		await pending;
	} finally {
		mock.restoreAll();
		syncBuiltinESMExports();
	}
	assert.equal(injected, true);
	assert.deepEqual(readRecords().map(record => record.session).sort(), ["historical-session", "writer-a", "writer-b"]);
	assert.equal(fs.existsSync(lockPath), false);
});

test("a busy rotation lock does not block logging or remove another writer's lock", async () => {
	const a = await agent();
	largeLog();
	fs.writeFileSync(`${LOG_PATH}.1`, `${JSON.stringify({ ...historical, session: "older-session" })}\n`);
	fs.writeFileSync(lockPath, "another writer");
	await a.input();
	assert.equal(fs.readFileSync(lockPath, "utf8"), "another writer");
	assert.deepEqual(readRecords().map(record => record.session), ["older-session", "historical-session", "fixture-session"]);
});

test("rotation failures release the owned lock and still record usage", async () => {
	const a = await agent();
	largeLog();
	const rename = fs.renameSync;
	mock.method(fs, "renameSync", (from: any, to: any) => {
		if (String(from) === LOG_PATH) throw new Error("fixture rotation failure");
		return rename(from, to);
	});
	syncBuiltinESMExports();
	try { await a.input(); }
	finally { mock.restoreAll(); syncBuiltinESMExports(); }
	assert.equal(fs.existsSync(lockPath), false);
	assert.deepEqual(readRecords().map(record => record.session), ["historical-session", "fixture-session"]);
});

test("multiple processes retain all records while sharing a rotating log", async () => {
	largeLog();
	const entry = new URL("../src/index.ts", import.meta.url).href;
	const worker = `
		import tracker from ${JSON.stringify(entry)};
		let input;
		tracker({ on(name, handler) { if (name === 'input') input = handler; }, registerCommand() {} });
		const ctx = { cwd: process.env.FIXTURE_CWD, model: { id: 'fixture' }, sessionManager: { getSessionId: () => process.env.FIXTURE_SESSION } };
		for (let i = 0; i < 20; i++) await input({ text: '/skill:fixture-skill' }, ctx);
	`;
	await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", worker], {
			env: { ...process.env, FIXTURE_SESSION: `process-${i}`, FIXTURE_CWD: join(root, `project-${i}`) },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr)));
	})));
	const records = readRecords();
	assert.equal(records.length, 81);
	assert.equal(records.filter(record => record.session === "historical-session").length, 1);
	for (let i = 0; i < 4; i++) assert.equal(records.filter(record => record.session === `process-${i}`).length, 20);
});

test("the standalone CLI reads the shared storage", async () => {
	const a = await agent();
	await a.input();
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--json"], {
		env: process.env, encoding: "utf8", cwd: dirname(fileURLToPath(import.meta.url)),
	});
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.summary.invocations, 1);
	assert.equal(report.summary.sessions, 1);
});
