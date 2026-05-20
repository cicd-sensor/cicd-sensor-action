# Development

This repository commits the bundled GitHub Action output under `dist/`.
Source changes must be followed by a build and a dist check.

## Setup

Install dependencies from the lockfile:

```sh
npm ci
```

## Common Checks

Run all local checks:

```sh
npm run check
```

This runs syntax checks, unit tests, dependency audit, rebuilds `dist/`,
and verifies that committed `dist/` is in sync with `src/`.

## Dependency Updates

Direct dependencies are pinned to exact versions in `package.json`.
To check the current state:

```sh
npm outdated --long
```

To update a direct dependency, install the explicit target version:

```sh
npm install @actions/core@3.0.1
npm install @actions/artifact@6.2.1
npm install -D @vercel/ncc@0.38.4
```

After any dependency change, run:

```sh
npm ci
npm run check
```

Do not use floating ranges such as `^` for direct dependencies. Keep
the resolved versions explicit so action builds are repeatable.

## Build Output

Build the action bundles:

```sh
npm run build
```

Verify that generated bundles match the committed files:

```sh
npm run check-dist
```

`dist/` is part of the release artifact for GitHub Actions and should
be committed when source changes affect the bundle.
