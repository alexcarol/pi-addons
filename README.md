# Pi add-ons

Public monorepo for Alex Carol's opt-in Pi extensions and add-ons, released under the [MIT License](LICENSE).

> [!WARNING]
> **Experimental.** Every package is pre-1.0 (`0.x`) and under active development. Commands, configuration, storage formats and behavior may change or break without notice. Use at your own risk.

## Packages

| Package | Purpose | Global installation from a checkout |
| --- | --- | --- |
| [`@alexcarol/pi-skill-tracker`](packages/skill-tracker/) | Local skill-loading telemetry, `/skill-stats`, and `/skill-doctor` | `pi install "$PWD/packages/skill-tracker"` |

Install individual packages, **not the workspace root**. Adding another workspace does not automatically enable it in every Pi session.

## Development

Requires Node.js **22.19+** and npm. No build step is needed: Pi loads extension TypeScript directly, and Node runs the tests using native type stripping.

```sh
git clone https://github.com/alexcarol/pi-addons.git
cd pi-addons
npm ci --ignore-scripts
npm run check
```

The check runs package-manifest validation, strict TypeScript checking, all workspace tests, and isolated smoke tests against the pinned Pi host. It requires no model credentials or network after dependencies are installed. CI tests Node 22 and 24 and separately runs `npm run audit` against the npm advisory service.

## Use from this checkout

```sh
pi install "$PWD/packages/skill-tracker"
```

This registers a **user-level local Pi package** without copying its source. Run `/reload` in existing Pi sessions; new sessions load it automatically. Keep the checkout at its installed path. Update it through normal Git operations, rerun checks, and reload Pi. Do not also keep a copy under project-local or global `extensions/`, or tracking would run twice.

Existing tracker data remains outside the repository in `~/.pi/agent/skill-usage.jsonl` and `~/.pi/agent/skill-catalog/`.

## Add another add-on

1. Create `packages/<name>/` with `package.json`, `src/`, `test/`, and a README.
2. Give it a unique `@alexcarol/pi-…` name, its own `0.x` version, `private: true` (prevents accidental npm publication), an experimental notice at the top of its README, and an explicit `pi` resource manifest.
3. Declare any host-supplied Pi libraries as wildcard peers; declare real runtime dependencies explicitly. Do not rely on hoisted undeclared dependencies.
4. Add its `test` script; the root workspace runner picks it up automatically. Add typed source/tests under the existing layout for root typechecking.
5. Run `npm run check`, then explicitly install that package if wanted.

Packages are not published to npm: every `package.json` keeps `private: true`, and no release automation is configured. Install add-ons from a local checkout.

See [the layout rationale and references](docs/package-layout.md).

## License

[MIT](LICENSE) © Alex Carol
