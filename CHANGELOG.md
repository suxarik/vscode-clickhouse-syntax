# Changelog

All notable changes to the ClickHouse SQL Syntax extension will be documented in this file.

## [1.2.1] - 2026-05-05

### Changed
- **Major codebase refactoring** — split monolithic `extension.ts` (1450 lines) into focused modules by separation of concerns:
  - `src/types.ts` — shared TypeScript interfaces
  - `src/schemaManager.ts` — schema loading, validation, file watching
  - `src/functionDocs.ts` — 200+ ClickHouse function database
  - `src/constants.ts` — detection patterns, keywords, data types
  - `src/sqlContext.ts` — SQL context detection helpers
  - `src/sqlFormatter.ts` — SQL formatting engine
  - `src/providers/hoverProvider.ts` — hover documentation provider
  - `src/providers/completionProvider.ts` — IntelliSense completion provider
  - `src/providers/signatureHelpProvider.ts` — function signature help provider
  - `src/providers/diagnosticProvider.ts` — diagnostic engine with advanced checks
  - `src/providers/codeActionProvider.ts` — code actions and refactorings
  - `src/extension.ts` — thin orchestrator (~120 lines) that wires everything together

### Added
- **Advanced diagnostics**
  - Missing `FINAL` warning for Replacing/Collapsing/VersionedCollapsingMergeTree tables
  - Inefficient `NOT IN` pattern detection
  - Unbounded `LIMIT` without `ORDER BY` warning
  - `OR` on different columns index inefficiency hint
- **Advanced code actions**
  - Add `FINAL` for deduplicating engines
  - Wrap equality filter in `indexHint()`
  - Real `SELECT *` expansion using schema column lists
  - `CASE WHEN` → `multiIf` conversion with proper syntax
- **Test infrastructure** — Jest + ts-jest setup with 28 unit tests covering:
  - SQL context detection (`isClickHouseSQL`, `extractTableReferences`, `hasClause`)
  - SQL formatter (keyword case, string preservation, clause breaking)
  - Function database completeness (200+ functions, all categories, no duplicates)
  - Constants validation (detection patterns, keywords, data types)

## [1.2.0] - 2026-05-05

### Added
- **Schema-aware IntelliSense** — define your database schema in JSON for intelligent completions
  - `clickhouse-schema.json` format with databases, tables, columns, and indexes
  - Auto-reload on schema file changes
  - Commands: `Reload Schema`, `Validate Schema`, `Generate Schema Template`
- **Enhanced Hover Documentation**
  - Detailed function info: signature, return type, category, examples
  - Table hover: engine, columns with types and descriptions
  - Column hover: data type, default value, description
  - Configurable via `clickhouse.hover.*` settings
- **Function Signature Help** — real-time parameter hints when typing function calls
  - Active parameter highlighting
  - Triggered automatically by `(` and `,`
  - Supports 200+ functions with full signature information
- **Diagnostics & Code Actions**
  - Schema validation: warns about unknown tables/columns
  - Best practices: suggests avoiding `SELECT *`
  - Quick fixes: expand `SELECT *`, convert to `PREWHERE`, `CASE` ↔ `multiIf`
- **Context-aware Completions**
  - Table suggestions in `FROM` / `JOIN` context
  - Column suggestions in `SELECT` / `WHERE` / `GROUP BY` / `ORDER BY`
  - `table.column` completions after typing `table.`
  - Fully qualified names (`database.table`)
- **200+ new function entries** expanded from 20 to 200+ with signatures, categories, return types
- **20+ new configuration options** for fine-grained control of all IntelliSense features


## [1.1.1] - 2026-02-27

### Fixed
- Fixed an issue where line comments were incorrectly gluing with the next code line
- Fixed keyword highlighting within comments

## [1.1.0] - 2026-02-27

### Added
- **Structural SQL formatter** — rewrote the formatting engine from scratch:
  - Each top-level clause (`SELECT`, `FROM`, `WHERE`, `PREWHERE`, `GROUP BY`, `ORDER BY`, `HAVING`, `LIMIT`, `SETTINGS`, `FORMAT`, all `JOIN` variants, `UNION ALL`, etc.) starts on its own line
  - `SELECT` / `GROUP BY` / `ORDER BY` column lists are expanded one item per indented line
  - `WHERE` / `PREWHERE` / `HAVING` / `JOIN ON` conditions expand `AND` / `OR` to their own indented lines
  - String literals, backtick/double-quoted identifiers, block comments, and line comments are protected from transformation
  - Multiple statements separated by `;` are formatted independently with a blank line between them
  - Nested subqueries inside parentheses are preserved (depth-tracked so inner keywords are not expanded)
- **`ClickHouse: Format Document` command** — available in:
  - **F1 / Command Palette** (`ClickHouse: Format Document`)
  - **Right-click context menu** on `.chsql`, `.ch.sql`, and `.sql` files
  - **Format Document** (`⇧⌥F`) keyboard shortcut via the VS Code formatting API

## [1.0.0] - 2024-02-26

### Added
- Initial release
- Syntax highlighting for ClickHouse SQL dialect
  - ClickHouse-specific data types (UInt8–UInt256, Int8–Int256, Float32/64, Decimal variants, String, FixedString, Date/DateTime/DateTime64, Array, Tuple, Map, Nested, Nullable, LowCardinality, UUID, IPv4, IPv6, Bool, Enum8/16)
  - Table engines (MergeTree family, Distributed, Buffer, Kafka, S3, HDFS, and more)
  - 400+ ClickHouse functions (aggregate, array, string, date/time, math, type conversion, conditional, geospatial, bitmap)
  - ClickHouse-specific keywords (PREWHERE, SAMPLE, FINAL, FORMAT, SETTINGS, TTL, CODEC, DEDUPLICATE, etc.)
  - Standard SQL keywords, operators, comments, strings, numbers
- Grammar injection into standard `.sql` files for seamless integration
- 40+ code snippets for common ClickHouse patterns
- Hover documentation for frequently-used ClickHouse functions
- Auto-completion for keywords, functions, and data types
- SQL formatter with configurable keyword case and indent size
- Language configuration (brackets, comments, auto-closing pairs, folding)
- Support for `.chsql` and `.ch.sql` file extensions
