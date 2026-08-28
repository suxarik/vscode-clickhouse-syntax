# ClickHouse SQL Syntax for VS Code

A VS Code extension providing rich syntax highlighting, intelligent completions, hover documentation, and code formatting for **ClickHouse SQL** dialect.

---

## Features

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

### Catalog

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.serverVersion` | `auto` | Target ClickHouse version, e.g. `24.8`. Newer functions are hidden from completion. |

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
```

`npm run catalog` starts `clickhouse/clickhouse-server` in Docker, reads the
introspection tables, rewrites `src/catalog/generated/` and the grammar's function
lists, and writes the documentation assets under `catalog/`. Pass
`--container <name>` to use a server you already have running. The generated output
is committed, so regeneration is a maintainer task rather than a build step.

The extension is bundled with esbuild; `dist/extension.js` is the only JavaScript
that ships. Language intelligence is built on a hand-written tokenizer
(`src/lexer.ts`) and keyword classifier (`src/keywords.ts`) rather than on regexes
over raw text — that is what keeps identifiers, string bodies and comment text from
being mistaken for SQL keywords.

---

## License

MIT License
