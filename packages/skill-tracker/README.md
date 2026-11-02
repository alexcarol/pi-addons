# @alexcarol/pi-skill-tracker

> [!WARNING]
> **Experimental (`0.x`).** Commands, report output, the usage-log format and storage locations may change or break without notice.

Local skill-loading telemetry and diagnostics for Pi. Requires Node.js **22.19+**; no runtime dependencies or build step.

## Install globally from this checkout

From the repository root:

```sh
pi install "$PWD/packages/skill-tracker"
```

This creates a user-level **local package** declaration in Pi's settings. Pi loads the source directly from the checkout; no extra copy or symlink under `extensions/` is needed. Remove any previous project-local/global copy to avoid duplicate tracking. Run `/reload` in existing Pi sessions.

## Commands

- `/skill-stats`: quick usage summary.
- `/skill-doctor [unused|health|<skill>]`: diagnostics and skill details.
- `node packages/skill-tracker/src/cli.ts --json`: machine-readable report outside Pi.

Existing history stays at `~/.pi/agent/skill-usage.jsonl`, with per-project catalogs in `~/.pi/agent/skill-catalog/`. `PI_SKILL_LOG` and `PI_SKILL_CATALOG_DIR` override storage.

Records describe explicit skill commands, read attempts and resource access—not proof that a skill's workflow was completed. They contain skill/session/model identifiers, timestamps and local paths, not prompt or tool-result bodies. Nothing is uploaded. Reports contain private project metadata; review before sharing.

## Rotation

Logs above 8 MiB rotate into `.1`. An exclusive `.rotate.lock` coordinates rotators, with the size checked again after acquiring it. Other sessions continue appending while rotation is busy; rotation errors must never interrupt the agent.

The lock records its owner's PID and is removed in `finally`. An abrupt process kill can leave it behind: logging continues, but rotation pauses. Remove an abandoned lock only after confirming its recorded PID is no longer running. The 8 MiB threshold is a soft limit.

## Development

From the repository root:

```sh
npm run test --workspace @alexcarol/pi-skill-tracker
npm run check
```

Tests use isolated temporary storage and clean it up. They cover tracking, long-name menu selection, rotation interleavings, lock contention/failure cleanup, four concurrent writer processes and the standalone CLI. Root host smoke tests also load the package with Pi's public discovery API from two isolated projects.
