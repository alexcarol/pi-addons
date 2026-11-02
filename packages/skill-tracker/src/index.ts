/**
 * skill-tracker
 *
 * Records every skill invocation to an append-only JSONL log shared by all
 * concurrently running pi sessions (no daemon), and reports on it.
 *
 * Detected invocations:
 *   1. "command"  - user typed /skill:name            (input event, pre-expansion)
 *   2. "read"     - model loaded a SKILL.md           (tool_call on read)
 *   3. "bash"     - model cat/head'd a SKILL.md       (tool_call on bash)
 *   4. "resource" - model read a file inside a skill dir (references/, scripts/)
 *
 * Commands:
 *   /skill-doctor [unused|health|<skill>]  full report + diagnostics
 *   /skill-stats                           quick top-10 notification
 *
 * Log:     ~/.pi/agent/skill-usage.jsonl   ($PI_SKILL_LOG)
 * Catalog: ~/.pi/agent/skill-catalog/      ($PI_SKILL_CATALOG_DIR)
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import {
	buildReport,
	formatDetail,
	formatHealth,
	formatRow,
	formatSummary,
	LOG_PATH,
	readCatalog,
	readRecords,
	type SkillInfo,
	type UsageRecord,
	type Via,
	writeCatalog,
} from "./report.ts";

/** Keep telemetry records small for append-only writes. */
const MAX_LINE_BYTES = 4000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export default function skillTracker(pi: ExtensionAPI) {
	let byFile = new Map<string, string>();
	let byDir: Array<{ dir: string; name: string }> = [];
	let seen = new Set<string>();
	let catalogWritten = false;

	const toInfo = (s: Skill): SkillInfo => ({
		name: s.name,
		description: s.description.slice(0, 300),
		descriptionLength: s.description.length,
		filePath: s.filePath,
		scope: s.sourceInfo?.scope ?? "user",
		hidden: !!s.disableModelInvocation,
	});

	const reindex = (skills: readonly Skill[] | undefined, cwd: string) => {
		if (!skills?.length) return;
		byFile = new Map(skills.map((s) => [resolve(s.filePath), s.name]));
		byDir = skills
			.map((s) => ({ dir: resolve(s.baseDir), name: s.name }))
			.sort((a, b) => b.dir.length - a.dir.length); // most specific first
		if (!catalogWritten) {
			catalogWritten = true;
			writeCatalog(cwd, skills.map(toInfo));
		}
	};

	const classify = (rawPath: string, cwd: string): { name: string; via: Via; path: string } | undefined => {
		const path = resolve(cwd, rawPath.replace(/^@/, ""));
		const name = byFile.get(path);
		if (name) return { name, via: "read", path };
		if (basename(path).toLowerCase() === "skill.md") return { name: skillNameFromFile(path), via: "read", path };
		const hit = byDir.find((d) => path.startsWith(d.dir + sep));
		return hit ? { name: hit.name, via: "resource", path } : undefined;
	};

	const record = (rec: Omit<UsageRecord, "ts" | "pid">) => {
		const key = `${rec.skill}:${rec.via}`;
		const full: UsageRecord = { ts: new Date().toISOString(), pid: process.pid, ...rec };
		if (!seen.has(key)) {
			seen.add(key);
			full.first = true;
		}
		appendRecord(full);
	};

	pi.on("session_start", async () => {
		seen = new Set();
		catalogWritten = false;
	});

	// Authoritative skill list for this session, refreshed every turn (cheap).
	pi.on("before_agent_start", async (event, ctx) => {
		reindex(event.systemPromptOptions?.skills, ctx.cwd);
	});

	// 1. Explicit /skill:name commands - the input event fires before expansion.
	pi.on("input", async (event, ctx) => {
		const match = /^\s*\/skill:([a-z0-9][a-z0-9-]*)/i.exec(event.text);
		if (match) {
			record({
				skill: match[1],
				via: "command",
				session: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				model: ctx.model?.id,
			});
		}
		return { action: "continue" as const };
	});

	// 2-4. Model-initiated loads. Skills are "invoked" by reading SKILL.md.
	pi.on("tool_call", async (event, ctx) => {
		const paths: string[] = [];
		if (event.toolName === "read") {
			const p = (event.input as { path?: string })?.path;
			if (p) paths.push(p);
		} else if (event.toolName === "bash") {
			const cmd = (event.input as { command?: string })?.command ?? "";
			for (const m of cmd.matchAll(/[\w./~@-]*SKILL\.md/gi)) paths.push(m[0]);
		}

		for (const p of paths) {
			const hit = classify(p, ctx.cwd);
			if (!hit) continue;
			record({
				skill: hit.name,
				via: event.toolName === "bash" ? "bash" : hit.via,
				session: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				model: ctx.model?.id,
				path: hit.path,
			});
		}
	});

	/* ------------------------------------------------------------- commands */

	pi.registerCommand("skill-doctor", {
		description: "Diagnose skill usage: what fires, what never fires, what it costs",
		getArgumentCompletions: (prefix) => {
			const opts = ["unused", "health", ...readCatalog().map((s) => s.name)];
			const hits = opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
			return hits.length > 0 ? hits : null;
		},
		handler: async (args, ctx) => {
			// Prefer this session's live skill list; fall back to the merged snapshot.
			const live = ctx.getSystemPromptOptions?.()?.skills;
			if (live?.length) writeCatalog(ctx.cwd, live.map(toInfo));
			const catalog = live?.length ? live.map(toInfo) : readCatalog();
			const report = buildReport(catalog, readRecords());
			const arg = args.trim();

			if (arg && arg !== "unused" && arg !== "health") {
				const row = report.rows.find((r) => r.name === arg);
				if (!row) return ctx.ui.notify(`Unknown skill: ${arg}`, "warning");
				return void (await ctx.ui.select(`skill-doctor: ${arg}`, formatDetail(row)));
			}
			if (arg === "health") {
				return void (await ctx.ui.select("skill-doctor: diagnostics", formatHealth(report.health)));
			}

			const rows = arg === "unused" ? report.rows.filter((r) => r.installed && r.total === 0) : report.rows;
			const lines = [
				...formatSummary(report).split("\n"),
				"",
				"--- diagnostics ---",
				...formatHealth(report.health),
				"",
				`--- skills (✓ used · unused ? removed) ---`,
				...rows.map(formatRow),
			];

			const picked = await ctx.ui.select("skill-doctor", lines);
			const name = picked?.match(/^[✓·?]\s+\S+\s+(\S+)/)?.[1];
			const row = name ? report.rows.find((r) => r.name === name) : undefined;
			if (row) await ctx.ui.select(`skill-doctor: ${row.name}`, formatDetail(row));
		},
	});

	pi.registerCommand("skill-stats", {
		description: "Quick skill usage summary",
		handler: async (_args, ctx) => {
			const report = buildReport(readCatalog(), readRecords());
			const used = report.rows.filter((r) => r.total > 0).slice(0, 10);
			if (used.length === 0) return ctx.ui.notify(`No skill usage recorded yet (${LOG_PATH})`, "info");
			ctx.ui.notify(`${formatSummary(report)}\n\n${used.map(formatRow).join("\n")}`, "info");
		},
	});
}

/* ------------------------------------------------------------------ storage */

function appendRecord(rec: UsageRecord): void {
	try {
		rotateIfNeeded();
		let line = `${JSON.stringify(rec)}\n`;
		if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
			// Drop the fat optional fields rather than risk a torn (non-atomic) write.
			line = `${JSON.stringify({ ...rec, path: undefined, cwd: rec.cwd.slice(-200) })}\n`;
		}
		mkdirSync(dirname(LOG_PATH), { recursive: true });
		// Append short JSONL records without a read/modify/write cycle.
		appendFileSync(LOG_PATH, line, "utf8");
	} catch {
		// Tracking must never break a session.
	}
}

function rotateIfNeeded(): void {
	const lockPath = `${LOG_PATH}.rotate.lock`;
	let lock: number | undefined;
	try {
		if (statSync(LOG_PATH).size <= MAX_LOG_BYTES) return;
		// Only rotators need coordination; a busy lock must never block appends.
		lock = openSync(lockPath, "wx", 0o600);
		writeFileSync(lock, `${process.pid}\n`, "utf8");
		// Another process may have rotated since our initial size check.
		if (statSync(LOG_PATH).size > MAX_LOG_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.1`);
	} catch {
		// Missing log, busy lock or failed rotation: continue recording usage.
	} finally {
		if (lock !== undefined) {
			try { closeSync(lock); } catch { /* best-effort cleanup */ }
			try { unlinkSync(lockPath); } catch { /* never disrupt a session */ }
		}
	}
}

function skillNameFromFile(file: string): string {
	try {
		const head = readFileSync(file, "utf8").slice(0, 2000);
		const m = /^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)/m.exec(head);
		if (m) return m[1].trim();
	} catch {
		/* fall through */
	}
	return basename(dirname(file));
}
