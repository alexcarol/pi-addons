# Repository guidelines

- This is a public, MIT-licensed npm-workspace monorepo. Each independently installable Pi add-on belongs in `packages/<name>/` with its own `package.json`, README, explicit `pi` manifest, source, and tests.
- Packages are experimental: keep versions below `1.0.0` and start each package README with an experimental notice. Do not remove either without approval.
- Keep the root and workspace packages `private: true` so nothing is published to npm. Do not add publishing or release automation without approval.
- Keep host-supplied Pi packages in wildcard peer dependencies, never runtime dependencies. Pin development dependencies and commit the shared root `package-lock.json`.
- Match Node.js support to the latest published Pi release. Query its supported range with `npm view @earendil-works/pi-coding-agent@latest engines.node --json`; keep package `engines.node`, CI, and runtime APIs compatible with that range. Keep this registry lookup out of offline checks.
- Add-ons are opt-in. Do not auto-enable every workspace or install packages into live Pi configuration during tests.
- Tests must use temporary storage and never read/write real session history, credentials, usage logs, or catalogs. No model/API credentials are required for checks.
- Before completion, run `npm run check`. Package tests, host-loader smoke tests, and CI must remain independent of provider credentials and network access after dependency installation.
- Everything committed is public. Never commit `.pi/`, credentials, environment secrets, live logs, catalogs, session exports, or employer- and organization-internal names, URLs, or references. Use inline synthetic fixtures.
