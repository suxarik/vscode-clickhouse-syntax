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
.ch-header-cell { cursor: pointer; user-select: none; position: relative; }
.ch-header-cell:hover { background: var(--vscode-list-hoverBackground); }
/* Over the cell, so sorting a column does not change how wide it is. */
.ch-sort {
  position: absolute; top: 0; right: 10px; height: 100%;
  display: flex; align-items: center; font-size: 9px; opacity: .8;
  background: inherit; padding-left: 4px; pointer-events: none;
}
/*
 * Inside the cell's own box, because the cell clips its overflow - a handle
 * straddling the border is half invisible and half unclickable.
 */
.ch-resizer {
  position: absolute; top: 0; right: 0; width: 9px; height: 100%;
  cursor: col-resize; z-index: 2; touch-action: none;
}
.ch-resizer::after {
  content: ''; position: absolute; top: 0; right: 3px; width: 3px; height: 100%;
}
.ch-resizer:hover::after, .ch-resizer.is-dragging::after {
  background: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
}
/* Keeps the resize cursor while the pointer wanders off the handle. */
body.ch-resizing, body.ch-resizing * { cursor: col-resize !important; user-select: none; }
/*
 * Measures a string in the grid's own font; never visible. Inherits from the
 * row rather than declaring a font, so what is measured is what is rendered.
 */
.ch-probe {
  position: absolute; top: -9999px; left: 0; visibility: hidden;
  white-space: pre; pointer-events: none;
}
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

.ch-chart { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.ch-chart-svg { flex: 1 1 auto; width: 100%; min-height: 0; }
.ch-chart-grid { stroke: var(--ch-border); stroke-width: 1; }
.ch-chart-axis {
  fill: var(--vscode-descriptionForeground); font-size: 11px;
  font-family: var(--vscode-font-family); text-anchor: end;
}
.ch-chart-bar { fill: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
.ch-chart-bar:hover { fill: var(--vscode-charts-purple, var(--vscode-textLink-activeForeground)); }
.ch-chart-line {
  fill: none; stroke: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
  stroke-width: 1.5; vector-effect: non-scaling-stroke;
}
.ch-chart-caption, .ch-chart-empty {
  color: var(--vscode-descriptionForeground); font-size: 11px; padding-top: 6px;
}
`;
