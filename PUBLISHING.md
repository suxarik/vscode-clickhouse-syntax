# Publishing the ClickHouse SQL Extension to the VS Code Marketplace

This guide covers everything needed to publish `clickhouse-syntax` to the
[Visual Studio Code Marketplace](https://marketplace.visualstudio.com/vscode).

---

## Table of Contents

- [Publishing the ClickHouse SQL Extension to the VS Code Marketplace](#publishing-the-clickhouse-sql-extension-to-the-vs-code-marketplace)
  - [Table of Contents](#table-of-contents)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Create a Microsoft / Azure Account](#2-create-a-microsoft--azure-account)
  - [3. Create a Personal Access Token (PAT)](#3-create-a-personal-access-token-pat)
    - [Step-by-step](#step-by-step)
  - [4. Create a Publisher](#4-create-a-publisher)
    - [Via the web UI (recommended for first time)](#via-the-web-ui-recommended-for-first-time)
    - [Via the CLI](#via-the-cli)
  - [5. Update package.json](#5-update-packagejson)
  - [6. Package the Extension](#6-package-the-extension)
  - [7. Publish to the Marketplace](#7-publish-to-the-marketplace)
    - [Log in with your PAT](#log-in-with-your-pat)
    - [Publish](#publish)
    - [Publish with a PAT inline (for CI/CD)](#publish-with-a-pat-inline-for-cicd)
  - [8. Update an Existing Version](#8-update-an-existing-version)
    - [Patch / minor / major bump](#patch--minor--major-bump)
    - [Manual bump](#manual-bump)
  - [9. Unpublish / Deprecate](#9-unpublish--deprecate)
  - [10. Marketplace Checklist](#10-marketplace-checklist)
  - [GitHub Actions CI/CD Example](#github-actions-cicd-example)
  - [Useful Links](#useful-links)

---

## 1. Prerequisites

Install the **VS Code Extension CLI** (`vsce`) globally (or use the local copy in `node_modules/.bin/`):

```bash
npm install -g @vscode/vsce
# verify
vsce --version
```

Make sure the extension compiles without errors:

```bash
npm install
npm run compile        # runs: tsc -p ./
```

---

## 2. Create a Microsoft / Azure Account

A Microsoft account is required to manage a Marketplace publisher.

1. Go to <https://aka.ms/vscode-create-publisher> — this redirects you to the
   [Marketplace Management portal](https://marketplace.visualstudio.com/manage).
2. Sign in with a **Microsoft account** (Outlook, Hotmail, Live) or any account
   linked to an Azure Active Directory tenant.
3. If you don't have one, create a free account at <https://account.microsoft.com>.

---

## 3. Create a Personal Access Token (PAT)

The `vsce` CLI authenticates to the Marketplace via a PAT from **Azure DevOps**.

### Step-by-step

1. Open <https://dev.azure.com> and sign in with your Microsoft account.
2. Click your **profile picture** (top-right) → **Personal access tokens**.
3. Click **+ New Token** and fill in:

   | Field | Value |
   |-------|-------|
   | **Name** | `vsce-publish` (any name) |
   | **Organization** | `All accessible organizations` |
   | **Expiration** | 90 days (or custom) |
   | **Scopes** | Custom defined → **Marketplace → Manage** ✔ |

4. Click **Create** — copy the token immediately; it won't be shown again.

> **Security tip:** store the token in a password manager or as a CI/CD secret,
> never commit it to version control.

---

## 4. Create a Publisher

A **publisher** is the unique namespace that owns your extension on the
Marketplace (e.g. `my-company`).

### Via the web UI (recommended for first time)

1. Go to <https://marketplace.visualstudio.com/manage>.
2. Click **Create publisher**.
3. Fill in:
   - **ID** — lowercase, no spaces (e.g. `clickhouse-community`). **This must match
     the `"publisher"` field in `package.json`.**
   - **Display name** — human-readable (e.g. `ClickHouse Community`).
   - **Description**, **Website**, **Twitter** — optional but improves discoverability.
4. Click **Create**.

### Via the CLI

```bash
vsce create-publisher clickhouse-community
# prompts for PAT and publisher details
```

---

## 5. Update package.json

Before publishing, make sure these fields are correct in [`package.json`](./package.json):

```jsonc
{
  "name": "clickhouse-syntax",           // extension ID (lowercase, no spaces)
  "displayName": "ClickHouse SQL Syntax",
  "description": "Syntax highlighting, auto-detection, formatting and 400+ completions for ClickHouse SQL dialect — MergeTree engines, ClickHouse-exclusive types, functions, and clauses.",
  "version": "1.0.0",                    // semver — bump before each publish
  "publisher": "SuXarikisme",            // publisher ID — MUST match what was registered on the Marketplace
  "repository": {
    "type": "git",
    "url": "https://github.com/suxarik/vscode-clickhouse-syntax.git"
  },
  "homepage": "https://github.com/suxarik/vscode-clickhouse-syntax#readme",
  "bugs": {
    "url": "https://github.com/suxarik/vscode-clickhouse-syntax/issues"
  },
  "galleryBanner": {
    "color": "#1A1A2E",
    "theme": "dark"
  },
  "keywords": ["clickhouse", "sql", "database", "syntax", "highlight"]
}
```

> The `version` field **must be bumped** for every new publish — the Marketplace
> rejects duplicate versions.

---

## 6. Package the Extension

Build the `.vsix` archive locally first to verify the package contents:

```bash
# using local vsce
./node_modules/.bin/vsce package --no-dependencies

# or using global vsce
vsce package --no-dependencies
```

Inspect the output:

```
 DONE  Packaged: clickhouse-syntax-1.0.0.vsix (15 files, 32 KB)
```

You can install the `.vsix` locally to test before publishing:

```bash
code --install-extension clickhouse-syntax-1.0.0.vsix
```

---

## 7. Publish to the Marketplace

### Log in with your PAT

```bash
vsce login clickhouse-community
# paste your PAT when prompted
```

Credentials are stored in your OS keychain and reused for future `vsce` calls.

### Publish

```bash
# Publish the already-built .vsix
vsce publish --packagePath clickhouse-syntax-1.0.0.vsix

# OR: build + publish in one step (runs vscode:prepublish first)
vsce publish --no-dependencies
```

On success the CLI prints:

```
 DONE  Published clickhouse-community.clickhouse-syntax v1.0.0.
```

It usually takes **5–10 minutes** for the extension to appear in search results.
Browse to:

```
https://marketplace.visualstudio.com/items?itemName=clickhouse-community.clickhouse-syntax
```

### Publish with a PAT inline (for CI/CD)

```bash
vsce publish --no-dependencies -p $VSCE_PAT
```

Set `VSCE_PAT` as a secret environment variable in your CI system (GitHub Actions,
GitLab CI, etc.).

---

## 8. Update an Existing Version

### Patch / minor / major bump

```bash
# bump patch version (1.0.0 → 1.0.1) AND publish
vsce publish patch --no-dependencies

# minor version (1.0.0 → 1.1.0)
vsce publish minor --no-dependencies

# major version (1.0.0 → 2.0.0)
vsce publish major --no-dependencies
```

These commands automatically update `"version"` in `package.json`, create a git
tag (`v1.0.1`), and publish in one step.

### Manual bump

1. Edit `"version"` in `package.json`.
2. Update [`CHANGELOG.md`](./CHANGELOG.md) with the new version section.
3. Commit and tag:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: release v1.0.1"
   git tag v1.0.1
   git push && git push --tags
   ```
4. Publish:
   ```bash
   vsce publish --no-dependencies
   ```

---

## 9. Unpublish / Deprecate

```bash
# Unpublish a specific version (cannot be re-published with same version)
vsce unpublish clickhouse-community.clickhouse-syntax@1.0.0

# Unpublish the entire extension (all versions)
vsce unpublish clickhouse-community.clickhouse-syntax
```

> ⚠️ Unpublishing is **permanent** — users will lose the ability to download
> that version. Prefer publishing a new patch release with a deprecation notice.

---

## 10. Marketplace Checklist

Use this checklist before publishing:

- [ ] `publisher` in `package.json` matches your Marketplace publisher ID
- [ ] `version` follows [semver](https://semver.org/) and is incremented
- [ ] `description` is clear, concise, and under 128 characters (shown in search)
- [ ] `keywords` array has up to 5 relevant terms
- [ ] `repository.url` points to a valid public GitHub/GitLab repo
- [ ] `icon` path is valid and the image is at least 128×128 px
- [ ] `galleryBanner.color` is set for a polished Marketplace page
- [ ] `README.md` contains screenshots or feature GIFs (greatly improves installs)
- [ ] `CHANGELOG.md` is up to date
- [ ] `LICENSE` file is present
- [ ] `.vscodeignore` excludes `node_modules`, `src`, test files, and maps
- [ ] Extension compiles without errors (`npm run compile`)
- [ ] Tested locally with `code --install-extension *.vsix`
- [ ] No sensitive data (tokens, passwords) in any committed file

---

## GitHub Actions CI/CD Example

Create `.github/workflows/publish.yml` to auto-publish on a version tag:

```yaml
name: Publish Extension

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Publish to VS Code Marketplace
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
        run: npx @vscode/vsce publish --no-dependencies -p $VSCE_PAT
```

Add `VSCE_PAT` as a **Repository secret** in GitHub Settings → Secrets and Variables → Actions.

---

## Useful Links

| Resource | URL |
|----------|-----|
| Marketplace Management | <https://marketplace.visualstudio.com/manage> |
| Extensions Publishing Docs | <https://code.visualstudio.com/api/working-with-extensions/publishing-extension> |
| `vsce` CLI Reference | <https://github.com/microsoft/vscode-vsce> |
| Azure DevOps PAT | <https://dev.azure.com> |
| Marketplace Search Tips | <https://code.visualstudio.com/docs/editor/extension-marketplace> |
| Extension Guidelines | <https://code.visualstudio.com/api/references/extension-guidelines> |
