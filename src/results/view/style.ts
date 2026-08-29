/**
 * How the result grid looks.
 *
 * Kept apart from the panel because the notebook renderer needs exactly these
 * styles and cannot import anything that touches `vscode` - a renderer runs in
 * its own iframe with no extension API at all.
 *
 * Colours come from VS Code's own variables throughout, so the grid follows the
 * user's theme in a webview and in a notebook output alike.
 */

export const GRID_STYLE = `
:root { --ch-border: var(--vscode-panel-border, rgba(128,128,128,.35)); }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; overflow: hidden;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
.ch-results { display: flex; flex-direction: column; height: 100vh; }
.ch-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 4px 8px;
  border-bottom: 1px solid var(--ch-border);
  font-family: var(--vscode-font-family);
}
.ch-filter {
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 2px 6px; min-width: 180px;
}
.ch-spacer-flex { flex: 1; }
.ch-menu { display: flex; align-items: center; gap: 2px; opacity: .8; font-size: 11px; }
.ch-menu button, .ch-cancel {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--ch-border); padding: 1px 6px; cursor: pointer; font-size: 11px;
}
.ch-menu button:hover, .ch-cancel:hover { background: var(--vscode-button-secondaryHoverBackground); }
.ch-cancel { color: var(--vscode-errorForeground); }
.ch-message {
  padding: 8px 12px; color: var(--vscode-errorForeground);
  background: var(--vscode-inputValidation-errorBackground, transparent);
  border-bottom: 1px solid var(--ch-border); white-space: pre-wrap;
  font-family: var(--vscode-font-family);
}
.ch-head { overflow-x: hidden; overflow-y: hidden; border-bottom: 1px solid var(--ch-border); }
.ch-head .ch-row { width: max-content; min-width: 100%; }
.ch-body .ch-row { width: max-content; min-width: 100%; }
.ch-scroller { flex: 1; overflow: auto; position: relative; }
.ch-spacer { position: absolute; top: 0; left: 0; width: 1px; }
.ch-table { position: absolute; top: 0; left: 0; right: 0; }
.ch-row { display: flex; white-space: nowrap; }
.ch-row:nth-child(even) { background: var(--vscode-list-hoverBackground, transparent); }
.ch-header-row { background: var(--vscode-editorWidget-background); font-weight: 600; }
.ch-cell {
  padding: 2px 8px; min-width: 60px; max-width: 480px; flex: 0 0 auto;
  overflow: hidden; text-overflow: ellipsis; line-height: 18px;
  border-right: 1px solid var(--ch-border);
}
.ch-header-cell { cursor: pointer; user-select: none; }
.ch-header-cell:hover { background: var(--vscode-list-hoverBackground); }
.ch-gutter {
  min-width: 48px; text-align: right; opacity: .5;
  position: sticky; left: 0; background: var(--vscode-editor-background);
}
.is-numeric { text-align: right; font-variant-numeric: tabular-nums; }
.is-null { opacity: .45; font-style: italic; }
.is-composite { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.ch-footer {
  padding: 3px 10px; border-top: 1px solid var(--ch-border);
  font-family: var(--vscode-font-family); font-size: 11px; opacity: .8;
}
.ch-detail {
  position: absolute; inset: 10% 10% auto 10%; max-height: 70vh; overflow: auto;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-focusBorder); box-shadow: 0 4px 16px rgba(0,0,0,.4);
}
.ch-detail-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px; border-bottom: 1px solid var(--ch-border);
  font-family: var(--vscode-font-family); font-weight: 600;
}
.ch-detail-close { background: none; border: none; color: inherit; cursor: pointer; }
.ch-detail-body { margin: 0; padding: 10px; white-space: pre-wrap; word-break: break-word; }
`;
