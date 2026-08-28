# Changelog

All notable changes to the ClickHouse SQL Syntax extension will be documented in this file.

## [1.5.0] - 2026-08-28

The parser release. Language intelligence now runs on a real ClickHouse SQL parser and a
scope binder instead of token heuristics, which is what makes the rest of this release
possible: the extension can finally tell a table from a column from an alias, and knows
what a CTE or subquery projects.

### Added

- **Error-tolerant recursive-descent parser** (`src/parser/`). It never throws and never
  stops early: unparseable regions become error nodes and parsing resumes at the next
  clause. A half-typed `SELECT a, FROM t WHERE` still yields a tree that knows the table
  is `t`, which is what completion needs while you are still typing. Covers SELECT
  (with CTEs, joins, ARRAY JOIN, window functions, set operations), INSERT, CREATE
  TABLE/VIEW, ALTER and DROP, with a precedence-climbing expression parser.
- **Scope binder**. Builds the scope tree — tables, aliases, CTEs, subquery projections,
  ARRAY JOIN aliases, lambda parameters, named windows — and resolves names against it.
  A FROM subquery and a CTE body are isolated from the query that uses them, while a
  correlated subquery in WHERE still sees the outer tables.
- **Lint rule engine**, replacing the fixed diagnostic list. Every finding carries a rule
  id, gets a severity from `clickhouse.diagnostics.rules`, and links to its
  documentation. 17 rules; `docs/rules.md` is generated from the registry by
  `npm run docs:rules`, so the reference cannot drift.
- **Inline rule suppression**, in the shape people already know:

  ```sql
  -- ch-lint-disable-next-line select-star
  SELECT * FROM events;
  SELECT * FROM events; -- ch-lint-disable-line select-star
  -- ch-lint-disable unknown-table, missing-final
  ```

- **New rules the parser makes possible**: `syntax-error`, `unknown-column`,
  `ambiguous-column`, `unknown-function` (version-aware), `aggregate-in-filter`
  (an aggregate in WHERE/PREWHERE, which ClickHouse rejects), `final-on-plain-mergetree`,
  `prewhere-on-non-mergetree` and `cross-join`. A column is never reported unknown while
  any table in scope has unknown columns.
- **Outline and breadcrumbs**: one entry per statement, CTEs nested under their query,
  and every column under a `CREATE TABLE`.
- **Folding** for statements, parenthesised blocks, block comments and runs of line
  comments.
- **Smart select** (`⌃⇧⌘→`) widening through the expression tree.
- **Semantic highlighting**: tables, columns, aliases, CTEs, lambda parameters, settings
  and column definitions each get their own scope — something a TextMate grammar
  structurally cannot do, since it only sees words. System tables and catalog functions
  are marked as library symbols.
- **Go to definition, find references, rename and highlight** for the names a query
  defines for itself — CTEs, table aliases, select-list aliases and lambda parameters.
  Tables and columns jump to their entry in the schema file instead.
- **Inlay hints** showing the type of each projected column, from the schema or the
  `system` catalog. Nothing is annotated unless it resolves to exactly one known table.
- **`clickhouse.format.maxLineWidth`** (default 100): long parenthesised argument and
  `IN` lists break onto their own lines instead of running off the screen. Formatting
  stays idempotent.
- **Web build** (`dist/web/extension.js`): the extension now runs in vscode.dev and
  github.dev. `Buffer` was the only Node-only dependency left and is gone.
- **`ClickHouse: Show Lint Rules`**, listing every rule with its effective severity.

### Changed

- **Completion scope comes from the binder.** It now offers the columns a CTE or a
  subquery projects — `WITH c AS (SELECT a, count() AS n FROM t) SELECT | FROM c` offers
  `a` and `n` — and a FROM subquery no longer sees the enclosing query's tables. Clause
  detection still comes from the token scan, which copes better with half-typed input.
- Diagnostics are computed from one cached analysis per document revision rather than
  re-scanning per feature.
- The legacy `diagnostics.schemaValidation` / `bestPractices` / `settingsValidation`
  toggles still work; they now switch off the corresponding rule groups.
- Pure catalog helpers moved to `src/catalog/helpers.ts` so build scripts and lint rules
  can use them without pulling in the extension host.

### Fixed

- The lexer read `t.1` as the number `.1`, so tuple element access parsed as a bare
  identifier. A leading `.` now starts a number only when no value precedes it.
- `LIMIT 3 BY user_id` did not recognise `BY` as a keyword, because the rule only looked
  at the immediately preceding word.
- `INSERT INTO t (a, b)` parsed the column list as a table function call.
- A half-typed qualifier (`SELECT e. FROM t`) swallowed the following clause keyword as
  part of the name, losing the FROM.

### Not in this release

- **The language server extraction is deliberately deferred.** The plan put the parser
  behind an LSP, but every feature above depends on the parser and none depend on the
  protocol: in-process is simpler to test, has no serialisation boundary, and the web
  build already works without a second worker bundle. The parser and binder are
  self-contained modules, so moving them behind a server later is mechanical.
- **Function arity checking.** `system.functions` does not report arity, and deriving it
  from signature strings with varargs and optional arguments would produce false
  positives.

### Infrastructure

- Test suite grown to 529 tests; coverage 83%. Includes a parser fuzz test over random
  token soup asserting it never throws and always terminates.

## [1.4.0] - 2026-08-28

The catalog release. Everything the extension knows about the ClickHouse dialect is now
read out of a real ClickHouse server rather than typed by hand, which took the function
count from 254 documented entries to 1858 functions with 1630 full documentation entries
— and removed the three separate hand-maintained lists that had already drifted apart.

**This release also ships everything from 1.3.0, which was never published separately.**
1.3.0 was the correctness release: language intelligence moved off regexes and onto a real
tokenizer, fixing defects that made the advertised features wrong on ordinary queries.

- Completions were dead in most queries. Clause detection kept the last clause *in its
  internal list order* that appeared anywhere in the document rather than the one nearest
  the cursor — and because `AND`/`OR` were last in that list, any query containing them
  offered no column completions in every later clause.
- The formatter uppercased identifiers: columns named `first`, `last`, `range`, `row`,
  `set`, `table`, `database`, `engine`, `partition`, `comment`, `type` or `format` were
  rewritten in place.
- The formatter emitted a double space after every clause keyword, and only worked at
  paren depth 0, leaving CTE bodies, subqueries and `CREATE TABLE` column lists on one line.
- `Convert to PREWHERE` produced invalid SQL, rewriting `WHERE x = 1` into
  `PREWHERE x = 1 WHERE`.
- Code actions ignored the cursor and the diagnostics, and mutated through the editor
  rather than a `WorkspaceEdit`, so a fix was not one undoable step.
- Language detection silently rewrote the language of any `.sql` **or plain text** file
  that looked like ClickHouse; it now asks first and remembers the answer per file.

See the [1.3.0 entry](CHANGELOG.md#130---2026-08-28) for the full list.

### Added

- **Generated catalog** (`npm run catalog`). `scripts/generate-catalog.mjs` starts a
  Dockerised ClickHouse, reads `system.functions`, `system.data_type_families`,
  `system.table_engines`, `system.settings`, `system.merge_tree_settings`,
  `system.formats`, `system.keywords` and the whole `system` database, and writes the
  catalog. Generated from ClickHouse 26.7.5.10:

  | | |
  |---|---|
  | functions | 1858 (1630 documented, with syntax, arguments, return values and examples) |
  | data types | 140 |
  | table engines | 83 (with their capability flags) |
  | settings | 2071 (1717 query + 354 MergeTree) |
  | formats | 112 |
  | keywords | 647 |
  | `system` tables | 134, with every column and its comment |

- **The TextMate grammar's function, data type and engine lists are generated from the
  same catalog**, so highlighting and IntelliSense can no longer disagree. This closes
  the three-sources-of-truth problem: the grammar, `constants.ts` and `functionDocs.ts`
  each carried their own list.
- **Clause-specific completion**: settings inside `SETTINGS`, output formats after
  `FORMAT`, table engines after `ENGINE =`.
- **The `system` database is built in.** `FROM system.` offers all 134 system tables;
  their columns complete and hover with no user schema at all.
- **Settings diagnostics**: `unknown-setting`, `experimental-setting` (for settings
  ClickHouse marks non-production) and `setting-type-mismatch`, aware of ClickHouse's
  semantic setting types (`MaxThreads`, `Milliseconds`, `NonZeroUInt64`, `BoolAuto`, …).
- **Version gating**: `clickhouse.serverVersion` hides functions introduced after the
  version you run, using each function's `introduced_in` from the catalog.
- `ClickHouse: Show Catalog Info` reports the catalog's ClickHouse version, counts and
  the effective version gate.
- Hover for settings, table engines, output formats, system tables and system columns.
- Signature help now covers every catalog function, names parameters from their
  documented argument lists, and expands optional groups so `substring(s, offset[, length])`
  offers three parameters rather than two.

### Changed

- **Catalog data is split into two tiers.** Names, signatures, snippets and setting types
  are bundled and parsed lazily on first use; documentation prose, setting descriptions
  and the `system` database ship as JSON assets read from disk only when something asks
  for them. Completion documentation is filled in through `resolveCompletionItem`, so
  building the list never touches an asset. Activation reads nothing.
- Hover, completion and signature help are now asynchronous, since they may consult an
  asset.
- `CH_DATA_TYPES` removed from `constants.ts` — it was a hand-typed 40-entry subset of
  the catalog's 140 and had no remaining callers. `CH_KEYWORDS` stays, deliberately: it
  is a curated list of phrases people type (`GROUP BY`, `LEFT ARRAY JOIN`), not the raw
  647-token keyword list.
- `FORMAT` is recognised as a clause keyword when nothing follows it yet, so completion
  fires on a half-typed `… FORMAT `.

### Fixed

- The mock `MarkdownString` used by the test suite ignored its constructor argument,
  which had been hiding empty documentation strings in tests.

### Infrastructure

- Bundle grew from 125 KB to 646 KB (the bundled catalog tier); the packaged `.vsix` is
  498 KB including the 1.8 MB of assets.
- Grammar tests: every regex compiles, alternations are ordered longest-first so a
  prefix cannot shadow a longer name, function patterns only match actual calls, and
  every catalog entry appears in the grammar.
- Test suite grown to 329 tests; coverage 84%.
- `scripts/**` excluded from the published extension.

## [1.3.0] - 2026-08-28

The correctness release. Language intelligence now runs on a real tokenizer instead of
regexes over raw text, which fixes a set of defects that made the advertised features
wrong on ordinary queries.

### Fixed

- **Completions were dead in most queries.** Clause detection kept the last clause *in
  its internal list order* that appeared anywhere in the document rather than the clause
  nearest the cursor. Because `AND`/`OR` were last in that list, any query containing
  them reported the wrong clause and offered no column completions in every later clause
  — `SELECT a FROM t WHERE x = 1 AND y = 2 ORDER BY |` reported `AND`. Clause detection
  now scans backwards from the cursor with paren-depth tracking.
- **The formatter uppercased identifiers.** Columns named `first`, `last`, `range`,
  `row`, `set`, `table`, `database`, `engine`, `partition`, `comment`, `type` or
  `format` were rewritten in place — `SELECT first, last FROM t` became
  `SELECT FIRST, LAST FROM t`. Keyword casing is now decided per token, with contextual
  rules for words that are also legal column names.
- **The formatter emitted a double space** after every non-body clause keyword
  (`FROM  t`) in every formatted document.
- **The formatter only worked at paren depth 0.** CTE bodies, subqueries, `CREATE TABLE`
  column lists and window specs were left on one long line. It now descends into them.
- **`Convert to PREWHERE` produced invalid SQL**, rewriting `WHERE x = 1` into
  `PREWHERE x = 1 WHERE`. It is now a term-level move that declines when the rewrite
  would leave `WHERE` empty or when a top-level `OR` makes the split unsafe.
- **Code actions ignored the cursor and the diagnostics.** They matched against the whole
  document, so the lightbulb appeared everywhere, and they mutated through the editor
  rather than a `WorkspaceEdit`, so a fix was not one undoable step. `Expand SELECT *`
  also matched the first `FROM` in the file regardless of which statement the star was in.
- **Diagnostics ran on every keystroke** with full-document regex scans and no debounce.
- **`missing-final` highlighted the wrong occurrence** of a table name, because it located
  the table with `indexOf` rather than the match offset.
- **`LIMIT` without `ORDER BY` was judged per document**, so one statement with an
  `ORDER BY` suppressed the warning for every other statement in the file.
- **CTEs were reported as unknown tables.**
- **Detection fired on prose.** `PREWHERE` in a comment, or a table name inside a string
  literal, counted as ClickHouse syntax.
- **Signature help was confused by parentheses inside strings and comments**, and could
  not resolve parameterised aggregates such as `quantile(0.5)(x)`.
- **Only the first matching schema file was loaded** when `clickhouse.schema.paths`
  matched several; all matches are now merged.
- **`Validate Schema` always reported success** whenever any schema was loaded. It now
  reports the actual problems, with their JSON paths, in an output channel.

### Changed

- **Language detection asks before switching.** New `clickhouse.detect.mode`
  (`off` / `prompt` / `auto`, default `prompt`) replaces the previous behaviour of
  silently rewriting the language of any `.sql` **or plain text** file that looked like
  ClickHouse. Answers are remembered per file, and the current state is shown in the
  status bar. Plain text files are opt-in via `clickhouse.detect.includePlaintext`.
- **The extension no longer activates for every plain text document**
  (`onLanguage:plaintext` is gone from `activationEvents`).
- **The formatter registers for the `clickhouse` language only.** Set
  `clickhouse.format.registerForSqlLanguage` to `true` to have it offered for plain
  `.sql` files as well, instead of competing with formatters for other SQL dialects.
- **Completion is scope-aware**: only columns from the tables actually in `FROM`/`JOIN`,
  resolved through aliases and CTEs, with `alias.` and `database.` prefixes handled, and
  results ranked so schema columns come before the function list. Completion is now
  silent inside string literals and comments, and no longer triggers on space or comma.
- **Hover prefers the tables in scope** when a column name appears in several tables, and
  links to the relevant ClickHouse documentation page.
- **Schema lookups are indexed** rather than scanning the whole schema per keystroke, and
  are case-insensitive.
- Categories: dropped `Machine Learning`, which did not describe anything the extension does.
- Documented function count in the README corrected — 800+ names highlighted, 250+ with
  full IntelliSense documentation (it previously claimed "400+" for both).

### Added

- `src/lexer.ts` — ClickHouse SQL tokenizer handling `--`/`#`/`/* */` comments, `''` and
  `\'` string escapes, backtick and double-quoted identifiers, `$tag$` heredocs, hex and
  binary literals, and multi-character operators.
- `src/keywords.ts` — keyword classifier that separates always-reserved words from words
  that are also ordinary column names.
- `src/refactors.ts` — the code-action rewrites as pure, unit-tested text transforms.
- `clickhouse.toggleLanguage` command, and a status bar item for the current mode.
- `clickhouse.diagnostics.debounceMs` and `clickhouse.completion.maxItems` settings.
- `capabilities.untrustedWorkspaces` / `virtualWorkspaces` declarations.

### Infrastructure

- esbuild bundling: the published extension ships a single `dist/extension.js`.
- ESLint + Prettier, and `npm run lint` in CI.
- CI now runs the test suite on Node 20 and 22 with a coverage floor, and the publish
  workflow is gated on lint and tests. Previously CI only compiled and packaged.
- Test suite grown from 28 to 245 tests; coverage from 16% to ~80%, with providers
  going from 0% to covered. Includes a formatter idempotency corpus.
- Stale `out/*.js` build output removed from version control.

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
