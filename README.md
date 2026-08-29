# ClickHouse SQL Syntax for VS Code

Write ClickHouse SQL with an editor that understands the dialect, connect to a server, run
the statement under your cursor, and read the result — without leaving the file.

---

## Features

### 🔌 Connect and run

Add a connection with **ClickHouse: Add Connection**, put the cursor in a statement, and
press `Ctrl+Enter` (`Cmd+Enter`).

- **Results stream in** as they arrive, in a virtualised grid. A million rows arrive in
  about 1.6 seconds and render as fewer than eighty rows of DOM. Sort, filter, expand
  nested `Array`/`Map`/`Tuple`/`JSON` cells, copy as TSV/CSV/JSON/Markdown, export to file.
- **64-bit integers stay exact** — they cross the wire as strings, because `JSON.parse`
  rounds anything past 2^53.
- **Cancel** sends `KILL QUERY`, so the work stops on the server.
- **Browse the schema** in the explorer: databases, tables, columns with types, engines,
  row counts and part counts, and dictionaries. It says so when it is showing a cache
  whose refresh failed.
- **Query history** with timings, re-run, and pinning for the queries worth keeping.
- **Profile the last query** against `system.query_log` — rows and bytes read, peak
  memory, threads.

**Read-only by default, and it means it.** A profile without `allowWrite` *refuses* a
write rather than prompting; a dialog you can click through is not a safety boundary.
Writes are recognised from the parse tree, `readonly=2` is sent so the server refuses
independently, and destructive statements confirm by name. Passwords go to the OS
credential store, never to `settings.json`.

See **[docs/connections.md](docs/connections.md)** for profiles, token auth, TLS, the
safety flags, and how to read a failed diagnosis.

### 🧭 Understand a query before you run it

- **EXPLAIN as a plan, not as text** — `PLAN indexes = 1`, `PIPELINE`, `ESTIMATE`,
  `SYNTAX`, `AST`, rendered as a tree that leads with what matters: which tables are read
  and how much each index actually removed (`parts 1/3 (33.3%)`). It says plainly when
  nothing was pruned.
- **Validate against the real server** on demand, via `EXPLAIN QUERY TREE` — it resolves
  every name without reading a row.
- **17 lint rules**, each individually configurable, for what a plan will not tell you.
  See [docs/rules.md](docs/rules.md) or run **ClickHouse: Show Lint Rules**.

### 🎨 Syntax Highlighting
Full syntax highlighting for ClickHouse-specific constructs:
- **ClickHouse data types**: `UInt8`, `UInt64`, `Float32`, `Float64`, `Decimal`, `String`, `FixedString`, `Date`, `DateTime`, `DateTime64`, `Array`, `Tuple`, `Map`, `Nested`, `Nullable`, `LowCardinality`, `IPv4`, `IPv6`, `UUID`, and more
- **Table engines**: `MergeTree`, `ReplicatedMergeTree`, `AggregatingMergeTree`, `CollapsingMergeTree`, `VersionedCollapsingMergeTree`, `Distributed`, `Kafka`, `S3`, and more
- **ClickHouse-specific keywords**: `PREWHERE`, `SAMPLE`, `FINAL`, `GLOBAL IN`, `ARRAY JOIN`, `WITH TOTALS`, `WITH ROLLUP`, `WITH CUBE`, `FORMAT`, `SETTINGS`, `TTL`, `CODEC`, and more
- **ClickHouse functions**: every function ClickHouse ships — 1858 names, highlighted by category (aggregate, array, string, date/time, math, type conversion, conditional), 1630 of them with full documentation
- Standard SQL keywords, operators, string literals, numbers, and comments

### ✍️ Code Snippets
40+ ready-to-use snippets for common ClickHouse patterns:

| Prefix | Description |
|--------|-------------|
| `sel` | Basic SELECT statement |
| `selg` | SELECT with GROUP BY |
| `sela` | SELECT with aggregations |
| `ctm` | CREATE TABLE (MergeTree) |
| `ctrm` | CREATE TABLE (ReplicatedMergeTree) |
| `ctd` | CREATE TABLE (Distributed) |
| `cmv` | CREATE MATERIALIZED VIEW |
| `cdict` | CREATE DICTIONARY |
| `cte` | Common Table Expression (WITH) |
| `win` | Window function |
| `case` | CASE WHEN expression |
| `mif` | multiIf function |
| `join` | JOIN clause |
| `amap` | arrayMap with lambda |
| `afilt` | arrayFilter with lambda |
| `quantile` | quantile function |
| `quantiles` | Multiple quantiles |
| `fmt` | FORMAT clause |
| `settings` | SETTINGS clause |

### 📖 Hover Documentation
Hover over ClickHouse functions, tables, and columns to see:
- **Functions**: signature, description, return type, usage examples
- **Tables**: engine, columns with types, descriptions
- **Columns**: data type, default value, description
- Links to official ClickHouse documentation

### 📚 Generated from ClickHouse itself

The function, data type, table engine, setting, format and `system` table catalogs
are not hand-maintained lists — they are read straight out of a running ClickHouse
server's own introspection tables (`system.functions`, `system.settings`,
`system.table_engines`, …) by `npm run catalog`. That is why they are complete and
cannot drift from the dialect. The TextMate grammar's function lists are generated
from the same source, so highlighting and IntelliSense can never disagree.

| | |
|---|---|
| functions | 1858 (1630 documented) |
| data types | 140 |
| table engines | 83 |
| settings | 2071 |
| formats | 112 |
| `system` tables | 134 |

`ClickHouse: Show Catalog Info` reports which ClickHouse version the shipped catalog
came from. Set `clickhouse.serverVersion` to your server's version and functions
introduced after it are hidden from completion.

### 💡 Auto-Completion
IntelliSense completions that follow the cursor's clause and the tables actually in scope:
- **Scope-aware columns**: only columns from the tables in your `FROM`/`JOIN`, resolved through aliases and CTEs
- **Qualified prefixes**: `e.` offers the columns of whatever `e` aliases; `analytics.` offers that database's tables
- **Schema-aware tables** from your schema definition, plus CTE names
- **Clause-specific lists**: settings inside `SETTINGS`, output formats after `FORMAT`, table engines after `ENGINE =`
- **`system` database built in**: `FROM system.` offers all 134 system tables, and their columns complete with no user schema at all
- **1858 ClickHouse functions** with snippet templates, version-gated against `clickhouse.serverVersion`
- **ClickHouse keywords** and all 140 data types
- Ranked so schema columns come before the function list
- Silent inside string literals and comments

### 🎯 Function Signature Help
Real-time parameter hints while typing function calls:
- Active parameter highlighting
- Parameter names and types
- Function return type
- Triggered automatically by `(` and `,`

### 🔍 Diagnostics & Code Actions
Smart error checking and quick fixes:
- **Schema validation**: warns about unknown tables/columns
- **Best practices**: suggests improvements (e.g., avoid `SELECT *`)
- **Quick fixes**: expand `SELECT *`, convert to `PREWHERE`, transform `CASE` ↔ `multiIf`

### 📊 Schema Definition
Define your database schema for enhanced IntelliSense:
```json
{
  "databases": [
    {
      "name": "analytics",
      "tables": [
        {
          "name": "events",
          "engine": "MergeTree",
          "columns": [
            { "name": "event_id", "type": "UInt64" },
            { "name": "event_time", "type": "DateTime" }
          ]
        }
      ]
    }
  ]
}
```
- Auto-reloads when schema file changes
- Schema validation and template generation commands

### 🔧 SQL Formatter

The formatter completely restructures your ClickHouse SQL for maximum readability:

- **Each SQL clause on its own line** — `SELECT`, `FROM`, `WHERE`, `PREWHERE`, `GROUP BY`, `ORDER BY`, `HAVING`, `LIMIT`, `SETTINGS`, `FORMAT`, all `JOIN` variants, `UNION ALL`, `INTERSECT`, `EXCEPT`
- **Column lists expanded** — every column in `SELECT`, `GROUP BY`, `ORDER BY` gets its own indented line
- **Conditions expanded** — `AND` / `OR` in `WHERE`, `PREWHERE`, `HAVING`, and `JOIN ON` each start a new indented line
- **Subqueries stay nested** — expressions inside parentheses are correctly skipped by the clause-splitter
- **Literals protected** — single-quoted strings, backtick/double-quoted identifiers, `--` comments, and `/* */` blocks are never altered
- **Multi-statement support** — multiple statements separated by `;` are formatted independently with a blank line between them
- **Identifiers are never rewritten** — columns named `first`, `last`, `range`, `row`, `set`, `table`, `database`, `engine`, `partition`, `comment`, `type` or `format` keep their casing, and function names keep theirs (`left(s, 2)` stays `left`)
- **Idempotent** — formatting an already-formatted document changes nothing
- **Three ways to invoke**:
  - **Right-click → ClickHouse: Format Document** (context menu)
  - **F1 → ClickHouse: Format Document** (command palette)
  - **`⇧⌥F`** — VS Code built-in Format Document shortcut

> The formatter registers for the `clickhouse` language only. Set
> `clickhouse.format.registerForSqlLanguage` to `true` if you also want it offered
> for plain `.sql` files.

**Before:**
```sql
select user_id,count() as cnt,sum(revenue) as rev from events where event_date>=today()-30 and status='active' group by user_id order by cnt desc limit 100
```

**After:**
```sql
SELECT
    user_id,
    count() AS cnt,
    sum(revenue) AS rev
FROM events
WHERE
    event_date >= today() - 30
    AND status = 'active'
GROUP BY
    user_id
ORDER BY
    cnt DESC
LIMIT 100
```

**Configurable options:**

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.format.enabled` | `true` | Enable/disable formatting |
| `clickhouse.format.keywordCase` | `upper` | `upper`, `lower`, or `preserve` |
| `clickhouse.format.indentSize` | `4` | Spaces per indent level |

### 💉 SQL Injection
ClickHouse-specific syntax is also highlighted inside standard `.sql` files via grammar injection, so you get ClickHouse type and function highlighting without changing the file language.

---

## File Association

The extension activates for files with extensions:
- `.chsql` — dedicated ClickHouse SQL files
- `.ch.sql` — ClickHouse SQL files with double extension

For standard `.sql` files, ClickHouse syntax is injected automatically via grammar injection.

### Automatic detection

When a `.sql` file contains ClickHouse-specific syntax, the extension offers to switch
its language mode to ClickHouse SQL. It **asks first** and remembers your answer per
file — it never silently rewrites a document's language.

| `clickhouse.detect.mode` | Behaviour |
|---|---|
| `prompt` *(default)* | Ask once per file, and remember the answer |
| `auto` | Switch matching files without asking |
| `off` | Never change a file's language automatically |

The status bar shows the current mode for the active file; click it to toggle between
ClickHouse SQL and plain SQL. `ClickHouse: Detect & Set ClickHouse SQL Language` in the
command palette does the same thing explicitly.

---

## Configuration

### Formatting

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.format.enabled` | `true` | Enable/disable SQL formatting |
| `clickhouse.format.keywordCase` | `upper` | Keyword case: `upper`, `lower`, or `preserve` |
| `clickhouse.format.indentSize` | `4` | Number of spaces for indentation |
| `clickhouse.format.registerForSqlLanguage` | `false` | Also offer this formatter for plain `sql` files |
| `clickhouse.format.maxLineWidth` | `100` | Break long parenthesised lists past this column (`0` disables) |

### Language detection

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.detect.mode` | `prompt` | `off`, `prompt`, or `auto` |
| `clickhouse.detect.includePlaintext` | `false` | Also consider plain text files |

### Schema

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.schema.enabled` | `true` | Enable schema-aware IntelliSense |
| `clickhouse.schema.paths` | `["./clickhouse-schema.json"]` | Schema file paths (glob supported) |
| `clickhouse.schema.autoRefresh` | `true` | Auto-reload schema on file changes |

### Completion

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.completion.enabled` | `true` | Enable code completion |
| `clickhouse.completion.includeKeywords` | `true` | Include keywords |
| `clickhouse.completion.includeFunctions` | `true` | Include functions |
| `clickhouse.completion.includeDataTypes` | `true` | Include data types |
| `clickhouse.completion.includeTables` | `true` | Include schema tables |
| `clickhouse.completion.includeColumns` | `true` | Include schema columns |
| `clickhouse.completion.includeQualifiedNames` | `true` | Include `db.table` names |
| `clickhouse.completion.maxItems` | `0` | Cap the item count (`0` = no limit) |

### Hover

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.hover.enabled` | `true` | Enable hover documentation |
| `clickhouse.hover.showTableSchema` | `true` | Show table info on hover |
| `clickhouse.hover.showColumnType` | `true` | Show column type on hover |
| `clickhouse.hover.showFunctionSignature` | `true` | Show function signature |
| `clickhouse.hover.showExamples` | `true` | Show usage examples |

### Signature Help

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.signatureHelp.enabled` | `true` | Enable function signature help |

### Diagnostics

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.diagnostics.enabled` | `true` | Enable diagnostics |
| `clickhouse.diagnostics.schemaValidation` | `true` | Validate tables/columns against schema |
| `clickhouse.diagnostics.bestPractices` | `true` | Show best practice suggestions |
| `clickhouse.diagnostics.debounceMs` | `300` | Delay after the last edit before re-analysing |
| `clickhouse.diagnostics.settingsValidation` | `true` | Validate names, tiers and value types in `SETTINGS` |
| `clickhouse.diagnostics.syntaxErrors` | `true` | Report statements that cannot be parsed |
| `clickhouse.diagnostics.rules` | `{}` | Severity per rule id |

### Editor features

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.semanticHighlighting.enabled` | `true` | Colour tables, columns and aliases from the parse tree |
| `clickhouse.inlayHints.columnTypes` | `true` | Show the data type after each projected column |

### Catalog

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.serverVersion` | `auto` | Target ClickHouse version, e.g. `24.8`. Newer functions are hidden from completion. |

### Connections and queries

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.connections` | `[]` | Server profiles. Passwords are stored separately, in the OS credential store. |
| `clickhouse.schema.source` | `both` | `connection`, `file` or `both` — where IntelliSense gets its tables |
| `clickhouse.schema.cacheTtlMinutes` | `60` | How long a cached server schema is used before refreshing |
| `clickhouse.schema.includeSystemDatabase` | `false` | Introspect `system` too (the bundled catalog already covers it) |
| `clickhouse.query.maxResultRows` | `100000` | Hard cap on rows pulled into the grid (`0` removes it) |
| `clickhouse.query.maxExecutionTime` | `60` | Seconds before ClickHouse aborts a query (`0` removes it) |
| `clickhouse.query.previewRows` | `100` | Rows fetched by **Preview Rows** in the explorer (`0` reads the whole table) |
| `clickhouse.query.showRunCodeLens` | `true` | Show a Run action above each statement |

### Code Actions

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.codeActions.enabled` | `true` | Enable code actions |
| `clickhouse.codeActions.quickFixes` | `true` | Enable quick fixes |
| `clickhouse.codeActions.refactorings` | `true` | Enable refactorings |
| `clickhouse.codeActions.transformations` | `true` | Enable transformations |

---

## Examples

### CREATE TABLE with MergeTree
```sql
CREATE TABLE analytics.events
(
    event_id     UInt64,
    user_id      UInt64,
    event_name   LowCardinality(String),
    event_time   DateTime,
    event_date   Date,
    properties   Map(String, String)
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/analytics.events', '{replica}')
PARTITION BY toYYYYMM(event_date)
ORDER BY (user_id, event_time)
TTL event_date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
```

### Analytical Query with ClickHouse Functions
```sql
SELECT
    user_id,
    groupArray(10)(event_name)              AS last_events,
    uniqExact(session_id)                   AS sessions,
    quantile(0.95)(response_time_ms)        AS p95_response,
    windowFunnel(86400)(
        event_time,
        event_name = 'page_view',
        event_name = 'add_to_cart',
        event_name = 'purchase'
    )                                        AS funnel_step,
    dictGet('default.users', 'country', user_id) AS country
FROM analytics.events
WHERE event_date >= today() - 30
  AND event_name IN ('page_view', 'add_to_cart', 'purchase')
PREWHERE user_id > 0
GROUP BY user_id
HAVING funnel_step > 0
ORDER BY sessions DESC
LIMIT 1000
SETTINGS max_threads = 8, use_query_cache = 1
FORMAT JSONEachRow
```

### Array Operations
```sql
SELECT
    arrayMap(x -> x * 2, [1, 2, 3, 4, 5])              AS doubled,
    arrayFilter(x -> x > 0, [-1, 0, 1, 2, 3])           AS positive,
    arraySort(arrayDistinct(groupArray(tag)))             AS unique_tags,
    arrayCumSum([1, 2, 3, 4, 5])                          AS running_total,
    arrayStringConcat(arrayMap(x -> toString(x), ids), ',') AS id_list
FROM events
```

---

## Supported ClickHouse Versions

This extension supports ClickHouse **22.x** and above, including all modern features:
- `DateTime64` with sub-second precision
- `Map` data type
- `JSON` / `Dynamic` data types
- `Variant` type
- Window functions
- `WITH TOTALS`, `WITH ROLLUP`, `WITH CUBE`
- Named collections
- Refreshable Materialized Views

---

## Contributing

Contributions are welcome — please open issues or pull requests on GitHub.

```bash
npm install
npm run compile      # type-check
npm run lint         # eslint
npm test             # jest
npm run test:coverage
npm run bundle       # esbuild -> dist/extension.js
npm run package      # build a .vsix
npm run catalog      # regenerate the catalog from a Dockerised ClickHouse
npm run docs:rules   # regenerate docs/rules.md from the rule registry
```

`npm run catalog` starts `clickhouse/clickhouse-server` in Docker, reads the
introspection tables, rewrites `src/catalog/generated/` and the grammar's function
lists, and writes the documentation assets under `catalog/`. Pass
`--container <name>` to use a server you already have running. The generated output
is committed, so regeneration is a maintainer task rather than a build step.

The extension is bundled with esbuild into `dist/extension.js` for the desktop host and
`dist/web/extension.js` for vscode.dev. The layers, bottom up:

| Module | Responsibility |
|---|---|
| `src/lexer.ts` | Tokenizer — comments, string escapes, quoted identifiers, heredocs |
| `src/keywords.ts` | Which words are keywords *here*, so `SELECT table FROM system.parts` keeps its column name |
| `src/parser/` | Error-tolerant recursive-descent parser and scope binder |
| `src/analysis.ts` | One cached parse + bind per document revision |
| `src/lint/` | The rule registry and the engine that applies severities and inline disables |
| `src/catalog/` | The generated ClickHouse catalog and its access layer |
| `src/providers/` | The VS Code surface: completion, hover, diagnostics, symbols, semantics, navigation |
| `src/client/` | HTTP client, connection profiles, statement classification and the safety gate |
| `src/results/` | Result grid — pure logic, plus a view behind a transport seam so it can also serve a notebook renderer |

Nothing reads raw text with regexes — that is what keeps identifiers, string bodies and
comment text from being mistaken for SQL.

---

## License

MIT License
