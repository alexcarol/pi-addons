#!/usr/bin/env node
/**
 * Standalone skill-doctor report — works outside pi, across all sessions.
 *
 *   node packages/skill-tracker/src/cli.ts            # full report
 *   node .../cli.ts unused                                      # never-invoked skills
 *   node .../cli.ts health                                      # diagnostics only
 *   node .../cli.ts brainstorming                               # one skill in detail
 *   node .../cli.ts --json                                      # machine readable
 *
 * Requires Node >= 22.18 (native TypeScript type stripping).
 */

import {
	buildReport,
	formatDetail,
	formatHealth,
	formatRow,
	formatSummary,
	LOG_PATH,
	readCatalog,
	readRecords,
} from "./report.ts";

const arg = process.argv[2] ?? "";
const report = buildReport(readCatalog(), readRecords());

if (arg === "--json") {
	console.log(JSON.stringify(report, null, 2));
} else if (arg === "health") {
	console.log(formatHealth(report.health).join("\n"));
} else if (arg && arg !== "unused") {
	const row = report.rows.find((r) => r.name === arg);
	if (!row) {
		console.error(`Unknown skill: ${arg}`);
		process.exit(1);
	}
	console.log(formatDetail(row).join("\n"));
} else {
	const rows = arg === "unused" ? report.rows.filter((r) => r.installed && r.total === 0) : report.rows;
	console.log(`skill-doctor  (${LOG_PATH})\n`);
	console.log(formatSummary(report));
	console.log("\n--- diagnostics ---");
	console.log(formatHealth(report.health).join("\n"));
	console.log("\n--- skills (✓ used · unused ? removed) ---");
	console.log(rows.map(formatRow).join("\n") || "(nothing recorded yet)");
}
