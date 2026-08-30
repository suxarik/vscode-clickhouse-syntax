# Changelog

All notable changes to this extension will be documented in this file.

## [2.3.0] - 2026-08-30

**The first Marketplace release since 1.5.0.** Everything in 2.0, 2.1 and 2.2 below ships
with it: connections and query execution, the result grid, notebooks and runbooks, dbt
awareness, and schema migrations. If you are upgrading from 1.x, start at
[2.0.0](#200---2026-08-28) — that is where the extension stopped being a language plugin.

The extension outgrew its name. It has not been a syntax highlighter since 2.0.

### Changed

- **Renamed to "ClickHouse SQL — IDE & Runbooks"** on the Marketplace, with a description
  that says what it actually does. The extension id is unchanged
  (`SuXarikisme.clickhouse-syntax`), so every existing install keeps working and updates
  normally.
- **The README is rewritten** around what it does today — connect and run, understand a
  query before running it, runbooks, dbt and migrations — rather than opening with syntax
  highlighting. Architecture and build notes moved to [CONTRIBUTING.md](CONTRIBUTING.md).

### Added

- **An `Explain` action above every query**, beside the existing `▷ Run`. It appears only
  on statements EXPLAIN has something to say about — a lens that errors when clicked is
  worse than no lens — and it says in its tooltip that explaining does not run the query.
  Turn it off with `clickhouse.query.showExplainCodeLens`.
- **`Ctrl+Shift+Enter` / `Cmd+Shift+Enter` explains the statement at the cursor.** It had
  no keybinding at all, which made the best feature in the extension the hardest to find.

## [2.2.3] - 2026-08-30

Column sizing, verified by rendering the real grid bundle in a real browser rather than
reasoning about it. 2.2.2 fixed the padding but left two faults behind.

### Fixed

- **Resizing did not work.** The handle sat half outside a cell that clips its overflow, so
  most of it was neither visible nor clickable, and pointer movement was tracked on the
  handle itself — a seven-pixel target the cursor leaves on the first movement. The handle
  is now nine pixels wide and wholly inside the cell, and movement is tracked on the window.
- **Every column carried two characters of slack** it did not need: the width included room
  for a sort arrow whether or not the column was sorted. The arrow is now drawn over the
  cell, so sorting a column no longer changes how wide it is either.
- **Widths came from a character count times an assumed character width.** That is only
  right for a monospace font at a known size, and wrong for the header regardless, since
  the header is bold. Widths are now measured from the strings actually being rendered, in
  the font actually in use. On the demo's own columns nothing is clipped and nothing has
  slack.
- The click that ends a drag is suppressed so it does not also sort — but the flag could
  outlive the drag and swallow a later, genuine click. It now clears itself on the next
  turn of the event loop.

## [2.2.2] - 2026-08-30

### Fixed

- **Result columns were about two characters too narrow**, so values were truncated that
  had room to fit — `2024-01-01` rendered as `2024-01-0…`. Columns were sized in `ch`
  units, but `box-sizing: border-box` takes the 8px padding either side and the 1px border
  out of that same box. Widths are now in pixels, measured from the grid's own rendered
  font, with the chrome added on top. On the demo's own columns that is 9.6 characters of
  room where 12 were needed.

### Added

- **Columns can be resized.** Drag a header edge, or double-click it to fit the column to
  its contents — which reads every loaded row, not just the 200-row sample the first
  measurement takes. A width you set by hand is never re-measured, so a later batch of
  streaming rows cannot undo it, and the click that ends a drag no longer sorts the column
  underneath it.

## [2.2.1] - 2026-08-30

### Fixed

- **A statement ending in `;` failed with a syntax error.** The request always ends with an
  appended `FORMAT JSONCompactEachRowWithNamesAndTypes`, because the grid can only read one
  format — so a trailing terminator made ClickHouse read that clause as a second statement
  and refuse the whole thing with *"Multi-statements are not allowed"*, pointing at a line
  the user never wrote. This hit **every notebook cell**, since saving a runbook terminates
  each cell that is followed by more SQL, and any run of a selection that included the
  semicolon. Found by running the demo runbook against a real server.
- A `FORMAT` clause of your own produced an equally baffling syntax error for the same
  reason. It cannot be honoured — the grid has no way to render CSV — so it is now replaced,
  and the query trace says which format was dropped rather than doing it silently.

Both are handled by tokenising rather than matching text, so a semicolon inside a string
literal and the word `FORMAT` inside a comment are left alone.

## [2.2.0] - 2026-08-29

dbt models, and migrations you read before you run.

### Added

#### dbt

- **dbt models parse.** `{{ … }}`, `{% … %}` and `{# … #}` are lexed whole and left
  opaque, because a dbt model is not ClickHouse SQL until dbt has compiled it and guessing
  at an expansion produces confident wrong answers. Control flow and comments are treated
  as trivia so the SQL between them parses normally; a leading `{{ config(...) }}` is
  skipped. Nine real dbt shapes — incremental models, `is_incremental()` blocks,
  `{{ this }}`, source/ref joins, whitespace control, macros in the select list, `for`
  loops, snapshot blocks, and an unterminated tag — all parse with zero diagnostics.
- **`ref()` and `source()` resolve** through dbt's own `target/manifest.json`, so a
  model's columns are known rather than guessed. The alias is used, since that is the name
  that reaches the warehouse, and dbt's `schema` maps to what ClickHouse calls a database.
  Seeds and snapshots are included; tests are not. Anything that is not plain string
  arguments resolves to nothing rather than to a guess.
- **The manifest is watched, not read once** — dbt rewrites it on every compile. A
  half-written one is kept out rather than replacing a good one.
- **Completion inside `{{ ref('…') }}`** offers model names, and `source('…', '…')`
  narrows the second argument by the first.
- `unknown-table` no longer fires on a tag the manifest cannot resolve. A warning on every
  model in an uncompiled project only teaches people to ignore warnings.

#### Migrations

- **ClickHouse: Compare Schema File with Server** diffs the schema file against live
  introspection and opens the `ALTER TABLE` script. The file is the intent, the server is
  the fact. Anything that could lose data is written out but **commented** — uncommenting
  is the correct amount of friction, and nothing is applied for you.
- **ClickHouse: Scaffold a Table** writes the local table, the `Distributed` table in
  front of it, and an `AggregatingMergeTree` rollup with its materialized view, in the
  order they must run. Replicated engines use the `{shard}`/`{replica}` macro form so the
  same DDL is correct on every replica.

#### Measuring, and documentation

- **ClickHouse: Show Performance Stats** runs the plan's performance budget in the real
  extension host and reports each measurement against its number. The integration suite
  asserts them too, so a regression fails the build. Measured in VS Code 1.135: activation
  **5.1 ms** (budget 150), full re-parse of 100 KB **15.3 ms** (budget 20), re-analysis
  after an edit **1.3 ms** (budget 5), completion on 5000 lines **7.1 ms** (budget 50).
- **[docs/runbooks.md](docs/runbooks.md)** covers the cell format, the safety rules,
  parameters, charts, and how to write your own.
- The fuzz suite now covers the notebook format, with a stronger obligation than "does not
  throw": the format must be a **fixed point**. If opening and saving a file twice changed
  it twice, a diff would grow every time you looked at it. Also fuzzed — no code cell is
  ever lost, every written line is SQL or a comment, and the lexer's tokens reassemble
  into exactly the input.

### Fixed

- The diff no longer emits an `ALTER` that ClickHouse refuses. Running the generated
  script against a real server surfaced `ALTER_OF_COLUMN_IS_FORBIDDEN`: a `MODIFY COLUMN`
  on a column in the sorting key cannot work, because it would change the representation
  of the primary key. That case now produces no statement and an explanation that the
  table has to be rebuilt.
- A single-node scaffold names the table plainly instead of `events_local` — a suffix
  distinguishing it from nothing.

### Changed

- The plan's "incremental re-parse < 5 ms" budget is restated. There is no incremental
  path, and measuring found the cost is linear at about 0.09 ms/KB — 1.3 ms for a
  large-but-real 20 KB file, 8.8 ms for a 100 KB one, cached per document version.
  Building incremental parsing to save 7 ms on a document nobody writes is not worth the
  complexity, so the budget names the size it measures and the report prints the rate, so
  the 100 KB figure is not hidden by the friendlier choice.

## [2.1.0] - 2026-08-29

Runbooks. Prose, a query, its output, then the next step - which is how incident and
capacity work against `system.query_log`, `system.parts` and `system.merges` actually
goes, and the one thing a SQL editor genuinely cannot do.

### Added

#### Notebooks

- **A notebook is a plain `.sql` file** with `-- %%` cell markers. No JSON container: the
  file stays a script you can pipe to `clickhouse-client`, diffs stay readable, and an
  existing `.sql` file becomes a notebook with no conversion step (*Open as Runbook*, or
  Open With). `*.runbook.sql` and `*.chnb.sql` open as notebooks by default; nothing else
  is taken over.
- **Outputs are never written to the file.** Not a promise about the code - the format has
  nowhere to put one. A file that persists query results is a way for production rows to
  end up in a commit.
- **One kernel per connection profile.** VS Code's kernel picker *is* the profile picker,
  and each kernel says what it is allowed to do, not just where it points. Per-cell
  profiles would let one file quietly span environments.
- **The same safety model as the editor**, because it is the same code: a cell goes
  through the gate, so a read-only profile refuses a write in a notebook exactly as it
  does in a `.sql` file. Interrupt sends `KILL QUERY`. Cells run in order and stop at the
  first failure, because a runbook is a sequence.
- **The result grid, unmodified**, as a notebook output renderer - its own ESM bundle in
  its own iframe with no `vscode` API. Sorting, filtering and nested-cell expansion all
  work; copy and export send the finished text back over renderer messaging.

#### Runbooks

- **Three templates that already know the system tables**, each verified against a real
  server: *Why is this cluster slow*, *Which parts are not merging*, *What is my query
  doing*. **ClickHouse: Open a Runbook Template**.
- **Parameter cells.** `{name:Type}` placeholders are prompted for once per notebook and
  sent as ClickHouse's own `param_<name>`, so the server substitutes them with the
  declared type - a date typed into a box can never be an injection. Values live for the
  session only, like the outputs. **ClickHouse: Reset Runbook Parameters** asks again.
- **Charts** for a two-column result: a label and a number gives bars, a time and a number
  gives a line. Drawn as inline SVG in the theme's own colours - no library, because the
  webview's CSP forbids loading one and a bar chart is not worth three hundred kilobytes.
  The toggle only appears when the result is actually chartable, and it follows the filter
  and sort, so what is drawn is what the rows above it would have shown.

### Fixed

- Cells are now statement-terminated when another query follows. Piping the first draft to
  a real `clickhouse-client` read `LIMIT 10`, a comment and the next `SELECT` as one
  malformed statement. The last cell is left alone, so a plain script still round-trips
  byte for byte.

### Changed

- `GRID_STYLE` moved out of `resultsPanel.ts`, which imports `vscode` and so cannot be
  reached from a renderer. The webview and the notebook now share one stylesheet.
- Query execution goes through a `ResultSink` seam, so the result panel and a notebook
  cell are two destinations for one implementation rather than two implementations.
- Categories gain *Data Science* and *Notebooks*.

## [2.0.0] - 2026-08-28

The connection release. Everything up to now made the editor understand ClickHouse; this
one lets it talk to one. Run a statement, read the result, see why the plan is slow, and
profile what it actually cost - without leaving the file you are writing.

### Added

#### Connections, and the rules around them

- **Connection profiles** in `clickhouse.connections`: host, port, protocol, user,
  database, and per-profile settings. Host, user and database accept `${env:VAR}`.
- **Passwords are never in settings.** *ClickHouse: Set Connection Password* stores them
  in the OS credential store through VS Code's `SecretStorage`.
- **Read-only by default.** A profile without `allowWrite` refuses anything that is not a
  read - it is a refusal, not a prompt you can click through. Writes are recognised from
  the parse tree, so a `DROP` inside a string or a comment is not one.
- **Two independent checks.** The statement is classified locally *and* `readonly=2` is
  sent, so ClickHouse refuses it too. Verified end to end: a `CREATE TABLE` on a
  read-only profile never leaves the client, and the server confirms no table was made.
- **Destructive statements confirm** (`DROP`, `TRUNCATE`, `ALTER ... DELETE`, `SYSTEM`),
  naming the profile and the target. `ALTER ... DELETE` and `ALTER ... DROP` are told
  apart from metadata ALTERs.
- **`protected` profiles** require the profile name typed out before any write.
- **The active profile is always in the status bar**, marked read-only or protected, with
  a warning colour on protected ones.
- **Connections are disabled in restricted mode**, since profiles come from workspace
  settings.

#### Running queries

- **`▷ Run` above every statement**, `⌘↵` / `Ctrl+↵`, or run the selection. A destructive
  statement says so in the lens, before anyone clicks it.
- **Results stream in** as they arrive. **Cancel** sends `KILL QUERY`, so the work stops
  on the server rather than just dropping the socket.
- **A virtualised result grid**: fifty thousand rows render as fewer than a hundred DOM
  nodes. Sort by column, filter, expand nested `Array`/`Map`/`Tuple`/`JSON` cells, copy as
  TSV/CSV/JSON/Markdown, export to a file, with read rows, bytes and elapsed in the footer.
  A million rows arrive in about 1.6 seconds and still render as fewer than eighty rows of
  DOM. The footer omits a read count rather than showing a wrong one: `X-ClickHouse-Summary`
  is written when headers flush, so on a long streamed result it is a snapshot, not a
  total - *Profile Last Query* reads the authoritative figures from `system.query_log`.
- **64-bit integers and decimals stay exact.** They cross the wire as strings, because
  `JSON.parse` rounds anything past 2^53 - a `UInt64` event id was otherwise displayed
  wrong. Sorting uses `BigInt` so the order is right too.

#### Knowing the server

- **Live schema introspection** from `system.tables` and `system.columns`, cached per
  profile on disk with a TTL. A stale cache is used immediately and refreshed in the
  background: a schema a few minutes old beats no completions at all.
  `clickhouse.schema.source` chooses between the server, the JSON file, or both - where
  both describe a table, the server wins and the file fills the gaps.
- **An explorer view**: databases, tables and columns, with engine, row count, size on
  disk and part count. Preview 100 rows, `SHOW CREATE`, copy the qualified name, or insert
  a column list or a ready-made `SELECT`.
- **EXPLAIN, read as a plan rather than as text.** `PLAN indexes = 1`, `PIPELINE`,
  `ESTIMATE`, `SYNTAX` and `AST`, opened as a read-only document that leads with what
  matters: which tables are read, and how much each index actually removed
  (`parts 1/3 (33.3%)  granules 8/24 (33.3%)`). It says plainly when nothing was pruned.
- **Query history** per workspace - what ran, against which profile, how long it took, and
  what failed. Pick one to run it again. It records statements, never rows.
- **Pin a query you want to keep.** Pinned entries sort to the top, are exempt from the
  200-entry cap, and survive clearing - clearing offers to keep them rather than quietly
  discarding what you marked. Pin from the button in the history picker, which stays open
  so pinning three queries does not mean opening it three times.
- **Profile the last query** against `system.query_log`: duration, rows and bytes read,
  peak memory, thread count.
- **Validate against the server** on demand. Uses `EXPLAIN QUERY TREE`, which resolves
  every name without reading a row - `EXPLAIN SYNTAX` was tried first and rejected,
  because it accepts a column that does not exist. Falls back to `EXPLAIN PLAN` on servers
  predating the analyzer.

#### Getting started

- **A first-run walkthrough**: connect, explore the schema, run a query, read the plan.
  Each step completes on the context key or command that proves it was done, not on a
  click-through.
- **[docs/connections.md](docs/connections.md)** covers profiles, token auth, TLS, what
  each safety flag permits, and how to read a failed diagnosis.

### Changed

- `engines.vscode` raised to `^1.86.0`, for a host with a global `fetch`. HTTP is the only
  transport: no binary codec to maintain, and it is the only one the web host can use.
- The result grid is built behind a transport seam, with the webview bootstrap isolated in
  one small file, so the notebook renderer planned for 2.1 reuses it rather than
  reimplementing it.

### Fixed

- The EXPLAIN plan parser measured indentation in spaces. ClickHouse 26 draws the operator
  level with box characters, which flattened the whole tree; the prefix is now measured as
  a whole.
- A syntax error position reported by ClickHouse is measured against what the server was
  sent, so the `EXPLAIN` prefix is discounted before the range is placed. A position that
  lands in the appended `FORMAT` clause falls back to underlining the statement.
- A user's own syntax error no longer makes the validator think the server is too old for
  `EXPLAIN QUERY TREE` - both report code 62, so only the message distinguishes them.

### Infrastructure

- Test suite grown to 759 tests; coverage 82%. The client, the safety gate, the grid and
  the plan parser are all covered, the grid through jsdom.
- Every parser in this release was checked against a real ClickHouse in Docker, not only
  against fixtures. That is how the 64-bit rounding, the box-drawing plan format and the
  `EXPLAIN SYNTAX` gap were found.

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
