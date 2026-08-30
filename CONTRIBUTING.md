# Contributing

Issues and pull requests are welcome.

## Build and test

```bash
npm install
npm run compile          # type-check
npm run lint             # eslint, zero warnings
npm test                 # jest — 1216 unit tests
npm run test:coverage    # with the coverage floor enforced
npm run test:integration # real VS Code, real ClickHouse
npm run test:all         # lint + unit + integration
npm run bundle           # esbuild -> dist/
npm run package          # build a .vsix
```

`F5` launches an Extension Development Host with the extension loaded.

### The integration suite needs a server

```bash
docker run -d --name ch-local -p 18123:8123 clickhouse/clickhouse-server
```

`CLICKHOUSE_TEST_URL` overrides the default `http://localhost:18123`. These tests
run the real extension in a real VS Code against a real server, which is where
every bug that reached a user was actually found: a request that hung in the
extension host, an explorer showing a cache as though it were live, a statement
terminator colliding with an appended `FORMAT` clause. A mocked transport sees
none of that.

### Regenerating the catalog

```bash
npm run catalog
```

Starts `clickhouse/clickhouse-server` in Docker, reads the introspection tables,
and rewrites `src/catalog/generated/`, the grammar's function lists, and the
documentation assets under `catalog/`. Pass `--container <name>` to use a server
you already have. The output is committed, so this is a maintainer task rather
than a build step.

`npm run docs:rules` regenerates [docs/rules.md](docs/rules.md) from the rule
registry, so the rule documentation cannot drift from the rules.

## Architecture

Bundled with esbuild into four targets: `dist/extension.js` (desktop),
`dist/web/extension.js` (vscode.dev), `dist/results.js` (the result webview) and
`dist/renderer.js` (the notebook output renderer).

| Module | Responsibility |
| --- | --- |
| `src/lexer.ts` | Tokenizer — comments, string escapes, quoted identifiers, heredocs, Jinja tags |
| `src/keywords.ts` | Which words are keywords *here*, so `SELECT table FROM system.parts` keeps its column name |
| `src/parser/` | Error-tolerant recursive-descent parser and scope binder |
| `src/analysis.ts` | One cached parse + bind per document revision |
| `src/lint/` | The rule registry, and the engine that applies severities and inline disables |
| `src/catalog/` | The generated ClickHouse catalog and its access layer |
| `src/providers/` | The VS Code surface: completion, hover, diagnostics, symbols, semantics, navigation |
| `src/client/` | HTTP client, connection profiles, statement classification, the safety gate |
| `src/results/` | Result grid — pure logic, plus a view behind a transport seam |
| `src/notebook/` | Cell format, serializer, controllers, renderer |
| `src/dbt/` | Jinja awareness and `target/manifest.json` resolution |
| `src/migrate/` | Schema diffing and table scaffolding |

**Nothing reads raw SQL with a regex.** That is what keeps identifiers, string
bodies and comment text from being mistaken for SQL — a `DROP` inside a string
literal is not a `DROP`, and a semicolon inside one does not end a statement.

### Two seams worth knowing about

**`ResultSink`** (`src/results/sink.ts`) is where a running query sends what it
produces. The result panel and a notebook cell are two destinations for one
implementation, so the safety gate, cancellation and history are written once.

**`Transport`** (`src/results/view/transport.ts`) is the seam between the grid
and its host. `GridView` knows only that interface, so the same code serves a
webview panel and a notebook renderer iframe — the renderer imports it
unmodified.

## What the tests are for

- **Unit tests** cover logic. They are fast and they run on every change.
- **Integration tests** cover the things a mock cannot: the extension host, the
  network, the real server's error messages.
- **The fuzz suite** covers what arbitrary input does to the parser and the
  notebook format. The format has a stronger obligation than "does not throw":
  it must be a *fixed point*, or opening and saving a file twice would change it
  twice.
- **`ClickHouse: Show Performance Stats`** measures the performance budget in the
  real extension host, and the integration suite asserts it — so a regression
  fails the build.

Coverage has a floor in `jest.config.js`, set just under what the suite reaches.
`src/integration` is excluded from the measure: it runs under
`@vscode/test-electron`, so counting it there would report the best-covered path
as the worst.

## Releasing

Pushing a `v*` tag triggers [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
which packages and publishes to the Marketplace.

`name` in `package.json` is part of the extension's identity
(`SuXarikisme.clickhouse-syntax`) and must not change — it would create a new
listing and orphan every existing install. `displayName` and `description` are
free to change.
