# Package layout and rationale

```text
pi-addons/
├── package.json              # private workspace root; orchestration only
├── package-lock.json         # one reproducible dependency lock
├── tsconfig.json             # strict checking across workspace source/tests
├── scripts/                  # package-policy and real Pi-loader checks
├── .github/workflows/ci.yml   # read-only CI, pinned Actions, Node 22/24
└── packages/
    └── skill-tracker/
        ├── package.json      # independently installable, explicit Pi manifest
        ├── README.md
        ├── src/              # runtime entry, reporting, standalone CLI
        └── test/             # isolated regression tests
```

## What follows Pi

- **npm workspaces and `packages/*`** follow [Pi's root manifest](https://github.com/earendil-works/pi/blob/main/package.json). The root is private and delegates test execution to workspaces.
- **A manifest per add-on** follows [Pi's package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md). Resource paths are explicit; installing a local package reads the checkout without copying it.
- **Wildcard host peers, pinned development host** follow the package dependency guidance: `@earendil-works/pi-coding-agent` is a `*` peer, and the root pins 1.4.0 for compatibility checks. No host SDK is a runtime dependency or bundled into an extension.
- **Patched development-host dependencies**: the published 1.4.0 host pins older `minimatch` and `undici` releases with npm advisories. Root overrides use 11.0.3 and 8.12.3, the versions in Pi's current upstream coding-agent manifest, and the loader/regression checks verify that combination. These overrides affect this checkout's dependency graph, not the user's installed Pi or the add-on's dependency-free runtime. CI fails on moderate-or-higher npm advisories.
- **One shared lockfile and `npm ci --ignore-scripts`** follow [Pi's CI](https://github.com/earendil-works/pi/blob/main/.github/workflows/ci.yml). CI Actions are pinned to verified commit SHAs, with read-only repository permissions and no persisted checkout credentials.

## Deliberate simplifications

This collection does not need Pi core's ordered multi-package build graph, bundling, model-catalog generation, or coordinated release tooling. TypeScript loads directly in Pi. Add-ons have independent versions, stay private, and are explicitly installed one at a time; future packages do not silently become globally active.

The public Pi extension-discovery API is exercised in a temporary agent directory from two temporary project directories. Test storage never points at real usage logs or credentials. Actual tracking state stays outside Git, including during local development.

A local checkout installation is intentional: it supports a private GitHub repository without npm publication, extra authentication inside Pi's package updater, or duplicate source copies. Do not move/delete the installed checkout without first removing or updating its Pi package declaration.
