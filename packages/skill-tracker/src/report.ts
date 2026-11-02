/**
 * Shared reporting layer for skill-tracker.
 *
 * Pure Node: no pi imports, so cli.ts can run this outside a session
 * (`node cli.ts`) via Node's native TypeScript type stripping.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = join(homedir(), ".pi", "agent");
export const LOG_PATH = process.env.PI_SKILL_LOG ?? join(AGENT_DIR, "skill-usage.jsonl");
export const CATALOG_DIR = process.env.PI_SKILL_CATALOG_DIR ?? join(AGENT_DIR, "skill-catalog");

export type Via = "command" | "read" | "bash" | "resource";

export interface UsageRecord {
	ts: string;
	skill: string;
	via: Via;
	session: string;
	cwd: string;
	pid: number;
	model?: string;
	path?: string;
	first?: true;
}

/** What pi currently has loaded, snapshotted so the CLI can report without pi. */
export interface SkillInfo {
	name: string;
	descriptionLength: number;
	description: string;
	filePath: string;
	scope: string;
	hidden: boolean;
}

/* ------------------------------------------------------------------ reading */

export function readRecords(logPath = LOG_PATH): UsageRecord[] {
	const out: UsageRecord[] = [];
	for (const file of [`${logPath}.1`, logPath]) {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const rec = JSON.parse(line) as UsageRecord;
				if (rec?.skill && rec.ts) out.push(rec);
			} catch {
				/* truncated tail line */
			}
		}
	}
	return out;
}

/**
 * One catalog file per cwd, written with tmp+rename. Per-process file names
 * mean no two writers ever touch the same file, so no locking is needed.
 */
export function writeCatalog(cwd: string, skills: SkillInfo[], dir = CATALOG_DIR): void {
	try {
		mkdirSync(dir, { recursive: true });
		const key = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
		const target = join(dir, `${key}.json`);
		const tmp = `${target}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ cwd, ts: new Date().toISOString(), skills }), "utf8");
		renameSync(tmp, target); // atomic replace
	} catch {
		/* never break a session over telemetry */
	}
}

export function readCatalog(dir = CATALOG_DIR): SkillInfo[] {
	const merged = new Map<string, SkillInfo>();
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	for (const f of files) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as { skills?: SkillInfo[] };
			for (const s of parsed.skills ?? []) if (s?.name) merged.set(s.name, s);
		} catch {
			/* ignore unreadable snapshot */
		}
	}
	return [...merged.values()];
}

/* ---------------------------------------------------------------- reporting */

export interface SkillRow {
	name: string;
	installed: boolean;
	hidden: boolean;
	scope: string;
	filePath: string;
	descriptionLength: number;
	total: number;
	byVia: Record<Via, number>;
	sessions: number;
	recent: number; // invocations in the last 30 days
	last?: string;
	first?: string;
	uses: UsageRecord[];
}

export interface Health {
	level: "error" | "warn" | "info";
	title: string;
	detail: string;
	fix?: string;
}

export interface Report {
	rows: SkillRow[];
	health: Health[];
	summary: {
		skills: number;
		used: number;
		unused: number;
		invocations: number;
		sessions: number;
		since?: string;
		catalogTokens: number;
		wastedTokens: number;
	};
}

const DAY = 86_400_000;

export function buildReport(catalog: SkillInfo[], records: UsageRecord[]): Report {
	const cutoff = Date.now() - 30 * DAY;
	const rows = new Map<string, SkillRow>();

	const blank = (name: string, info?: SkillInfo): SkillRow => ({
		name,
		installed: !!info,
		hidden: info?.hidden ?? false,
		scope: info?.scope ?? "removed",
		filePath: info?.filePath ?? "",
		descriptionLength: info?.descriptionLength ?? 0,
		total: 0,
		byVia: { command: 0, read: 0, bash: 0, resource: 0 },
		sessions: 0,
		recent: 0,
		uses: [],
	});

	for (const info of catalog) rows.set(info.name, blank(info.name, info));

	const sessionsPerSkill = new Map<string, Set<string>>();
	const allSessions = new Set<string>();
	for (const rec of records) {
		const row = rows.get(rec.skill) ?? blank(rec.skill);
		rows.set(rec.skill, row);
		row.total++;
		if (rec.via in row.byVia) row.byVia[rec.via]++;
		if (!row.last || rec.ts > row.last) row.last = rec.ts;
		if (!row.first || rec.ts < row.first) row.first = rec.ts;
		if (Date.parse(rec.ts) >= cutoff) row.recent++;
		row.uses.push(rec);
		if (rec.session) {
			const set = sessionsPerSkill.get(rec.skill) ?? new Set<string>();
			set.add(rec.session);
			sessionsPerSkill.set(rec.skill, set);
			allSessions.add(rec.session);
		}
	}
	for (const [name, set] of sessionsPerSkill) {
		const row = rows.get(name);
		if (row) row.sessions = set.size;
	}
	for (const row of rows.values()) row.uses.sort((a, b) => b.ts.localeCompare(a.ts));

	const list = [...rows.values()].sort(
		(a, b) => b.total - a.total || Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name),
	);

	// Rough system-prompt cost: name + description, ~4 chars per token.
	const tokens = (r: SkillRow) => Math.round((r.descriptionLength + r.name.length + 40) / 4);
	const inPrompt = list.filter((r) => r.installed && !r.hidden);
	const catalogTokens = inPrompt.reduce((n, r) => n + tokens(r), 0);
	const wastedTokens = inPrompt.filter((r) => r.total === 0).reduce((n, r) => n + tokens(r), 0);

	return {
		rows: list,
		health: diagnose(list, records, { catalogTokens, wastedTokens }),
		summary: {
			skills: list.filter((r) => r.installed).length,
			used: list.filter((r) => r.installed && r.total > 0).length,
			unused: list.filter((r) => r.installed && r.total === 0).length,
			invocations: records.length,
			sessions: allSessions.size,
			since: records.reduce<string | undefined>((min, r) => (!min || r.ts < min ? r.ts : min), undefined),
			catalogTokens,
			wastedTokens,
		},
	};
}

function diagnose(rows: SkillRow[], records: UsageRecord[], cost: { catalogTokens: number; wastedTokens: number }): Health[] {
	const health: Health[] = [];
	const listNames = (rs: SkillRow[], max = 6) =>
		rs
			.slice(0, max)
			.map((r) => r.name)
			.join(", ") + (rs.length > max ? `, +${rs.length - max} more` : "");

	const unused = rows.filter((r) => r.installed && !r.hidden && r.total === 0);
	if (unused.length > 0) {
		health.push({
			level: "warn",
			title: `${unused.length} skill(s) never invoked`,
			detail: `${listNames(unused)} — costing ~${cost.wastedTokens} tokens of system prompt every session`,
			fix: "Sharpen the description, or remove/disable the skill if it is not needed here",
		});
	}

	const manualOnly = rows.filter((r) => r.installed && !r.hidden && r.total >= 3 && r.byVia.command === r.total);
	if (manualOnly.length > 0) {
		health.push({
			level: "warn",
			title: `${manualOnly.length} skill(s) only ever invoked manually`,
			detail: `${listNames(manualOnly)} — the model never picked them up on its own`,
			fix: "The description is not matching real prompts: state concretely when to use the skill",
		});
	}

	const badDesc = rows.filter((r) => r.installed && (r.descriptionLength > 1024 || (r.descriptionLength > 0 && r.descriptionLength < 40)));
	if (badDesc.length > 0) {
		health.push({
			level: "warn",
			title: `${badDesc.length} skill(s) with a problematic description`,
			detail: badDesc
				.slice(0, 6)
				.map((r) => `${r.name} (${r.descriptionLength} chars)`)
				.join(", "),
			fix: "Agent Skills spec caps descriptions at 1024 chars; under ~40 chars rarely triggers",
		});
	}

	const stale = rows.filter((r) => !r.installed && r.total > 0);
	if (stale.length > 0) {
		health.push({
			level: "info",
			title: `${stale.length} skill(s) in the log are no longer installed`,
			detail: listNames(stale),
			fix: "Historic data only — the skill was renamed, uninstalled, or lives in another project",
		});
	}

	const hidden = rows.filter((r) => r.installed && r.hidden);
	if (hidden.length > 0) {
		health.push({
			level: "info",
			title: `${hidden.length} skill(s) hidden from the model`,
			detail: `${listNames(hidden)} — disable-model-invocation: true, reachable only via /skill:name`,
		});
	}

	const modelDriven = records.filter((r) => r.via !== "command").length;
	health.push({
		level: "info",
		title: "Invocation mix",
		detail: `${modelDriven} model-initiated vs ${records.length - modelDriven} explicit /skill: commands; skill catalog ≈${cost.catalogTokens} tokens/session`,
	});

	return health;
}

/* --------------------------------------------------------------- formatting */

export function ago(iso?: string): string {
	if (!iso) return "never";
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms)) return "?";
	if (ms < 60_000) return "just now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < DAY) return `${Math.floor(ms / 3_600_000)}h ago`;
	return `${Math.floor(ms / DAY)}d ago`;
}

export function formatRow(row: SkillRow): string {
	const mark = !row.installed ? "?" : row.total === 0 ? "·" : "✓";
	const count = row.total === 0 ? "unused" : `${row.total}x`;
	const mix = row.total === 0 ? "" : `m:${row.byVia.read + row.byVia.bash} c:${row.byVia.command} r:${row.byVia.resource}`;
	return [
		`${mark} ${count.padStart(7)}`,
		row.name.padEnd(30),
		`${String(row.sessions).padStart(3)} sess`,
		ago(row.last).padStart(9),
		mix.padEnd(14),
		row.hidden ? "hidden" : row.scope,
	].join("  ");
}

export function formatSummary(r: Report): string {
	const s = r.summary;
	return [
		`${s.skills} skills installed · ${s.used} used · ${s.unused} unused`,
		`${s.invocations} invocations across ${s.sessions} sessions since ${s.since?.slice(0, 10) ?? "n/a"}`,
		`skill catalog ≈${s.catalogTokens} tokens/session, ~${s.wastedTokens} of it never used`,
	].join("\n");
}

export function formatHealth(health: Health[]): string[] {
	const icon = { error: "✗", warn: "!", info: "i" } as const;
	const lines: string[] = [];
	for (const h of health) {
		lines.push(`${icon[h.level]} ${h.title}`);
		lines.push(`    ${h.detail}`);
		if (h.fix) lines.push(`    → ${h.fix}`);
	}
	return lines;
}

export function formatDetail(row: SkillRow): string[] {
	const lines = [
		`${row.name}${row.hidden ? "  (hidden from model)" : ""}`,
		`scope        ${row.scope}${row.installed ? "" : "  (not installed anymore)"}`,
		`file         ${row.filePath || row.uses[0]?.path || "-"}`,
		`invocations  ${row.total} total, ${row.recent} in last 30d, ${row.sessions} distinct sessions`,
		`breakdown    model-read ${row.byVia.read}, bash ${row.byVia.bash}, /skill: ${row.byVia.command}, sub-file ${row.byVia.resource}`,
		`first / last ${row.first?.slice(0, 16).replace("T", " ") ?? "-"}  /  ${row.last?.slice(0, 16).replace("T", " ") ?? "-"} (${ago(row.last)})`,
		"",
		"recent uses:",
	];
	for (const use of row.uses.slice(0, 8)) {
		lines.push(
			`  ${use.ts.slice(0, 16).replace("T", " ")}  ${use.via.padEnd(8)} ${(use.model ?? "?").padEnd(18)} ${use.cwd}`,
		);
	}
	if (row.uses.length === 0) lines.push("  (never invoked)");
	return lines;
}
