## Explore the schema

The **ClickHouse** view in the explorer lists databases, tables, columns with
their types, and dictionaries — read live from the server and cached for the
next session.

- **Preview Rows** opens the first 100 rows, with an automatic `LIMIT`.
- **Show CREATE TABLE** opens the definition read-only.
- **Insert Column List** writes the columns into your editor.

The same schema drives completion and diagnostics, so a misspelled column is
underlined as you type rather than at run time.

If the view is showing a cache whose refresh failed, it says so. A connection
that has stopped working should not pass for a healthy one.
