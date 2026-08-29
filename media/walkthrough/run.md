## Run a query

Put the cursor in a statement and press `Ctrl+Enter` (`Cmd+Enter` on macOS).
The statement under the cursor runs — you do not have to select it.

Results stream in as they arrive. The grid virtualises, so a million rows opens
as fast as ten.

- **Sort and filter** from the column headers.
- **Copy** a cell, a row, or the whole result as CSV, TSV, JSON or Markdown.
- **Cancel** sends `KILL QUERY`, so the work stops on the server rather than the
  connection merely being dropped.

Every result names the profile it came from, so you always know which server
answered.
