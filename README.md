# ClickHouse SQL Syntax for VS Code

A VS Code extension providing rich syntax highlighting, intelligent completions, hover documentation, and code formatting for **ClickHouse SQL** dialect.

---

## Features

### 🎨 Syntax Highlighting
Full syntax highlighting for ClickHouse-specific constructs:
- **ClickHouse data types**: `UInt8`, `UInt64`, `Float32`, `Float64`, `Decimal`, `String`, `FixedString`, `Date`, `DateTime`, `DateTime64`, `Array`, `Tuple`, `Map`, `Nested`, `Nullable`, `LowCardinality`, `IPv4`, `IPv6`, `UUID`, and more
- **Table engines**: `MergeTree`, `ReplicatedMergeTree`, `AggregatingMergeTree`, `CollapsingMergeTree`, `VersionedCollapsingMergeTree`, `Distributed`, `Kafka`, `S3`, and more
- **ClickHouse-specific keywords**: `PREWHERE`, `SAMPLE`, `FINAL`, `GLOBAL IN`, `ARRAY JOIN`, `WITH TOTALS`, `WITH ROLLUP`, `WITH CUBE`, `FORMAT`, `SETTINGS`, `TTL`, `CODEC`, and more
- **ClickHouse functions**: 400+ functions across categories (aggregate, array, string, date/time, math, type conversion, conditional)
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
Hover over ClickHouse functions to see:
- Function signature
- Description
- Usage examples

### 💡 Auto-Completion
IntelliSense completions for:
- All ClickHouse keywords and clauses
- 400+ ClickHouse functions with snippet templates
- ClickHouse data types
- Available for both `.chsql` and `.sql` files

### 🔧 SQL Formatter
Format ClickHouse SQL with configurable options:
- **Keyword case**: UPPER, lower, or preserve original
- **Indent size**: Configurable number of spaces
- Works with Format Document (`⇧⌥F`) and Format Selection

### 💉 SQL Injection
ClickHouse-specific syntax is also highlighted inside standard `.sql` files via grammar injection, so you get ClickHouse type and function highlighting without changing the file language.

---

## File Association

The extension activates for files with extensions:
- `.chsql` — dedicated ClickHouse SQL files
- `.ch.sql` — ClickHouse SQL files with double extension

For standard `.sql` files, ClickHouse syntax is injected automatically via grammar injection.

You can also manually set the language to **ClickHouse SQL** using the language selector in the VS Code status bar.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `clickhouse.format.enabled` | `true` | Enable/disable SQL formatting |
| `clickhouse.format.keywordCase` | `upper` | Keyword case: `upper`, `lower`, or `preserve` |
| `clickhouse.format.indentSize` | `4` | Number of spaces for indentation |

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

Contributions are welcome! Please open issues or pull requests on GitHub.

---

## License

MIT License
