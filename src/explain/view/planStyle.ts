/**
 * How the plan view looks.
 *
 * Colours come from the editor's theme throughout. The layout's one job is to
 * keep the drawing the largest thing on screen: a toolbar thin enough to
 * forget, a summary line that fits on one row, and everything else given over
 * to the plan.
 */

export const PLAN_STYLE = `
:root {
  --ch-border: var(--vscode-panel-border, rgba(128,128,128,.35));
  --ch-row: 26px;
}
* { box-sizing: border-box; }
body {
  margin: 0; overflow: hidden;
  font-family: var(--vscode-font-family);
  font-size: 12px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  /* Metrics are read in columns, so the digits have to line up. */
  font-variant-numeric: tabular-nums;
}
.ch-plan { display: flex; height: 100vh; }

.ch-pane-explain {
  width: 38%; min-width: 180px; display: flex; flex-direction: column;
  border-right: 1px solid var(--ch-border);
}
.ch-explain-head, .ch-toolbar {
  display: flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 8px; flex: 0 0 30px;
  border-bottom: 1px solid var(--ch-border);
  color: var(--vscode-descriptionForeground);
}
.ch-explain-body {
  flex: 1; overflow: auto; margin: 0; padding: 8px 10px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  line-height: 1.5; white-space: pre; tab-size: 2;
}
.ch-explain-body .ch-line { display: block; padding: 0 4px; border-radius: 2px; }
.ch-explain-body .ch-line.ch-match {
  background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.33));
}

.ch-divider {
  flex: 0 0 5px; cursor: col-resize; background: transparent;
}
.ch-divider:hover, .ch-divider.ch-dragging { background: var(--vscode-focusBorder); }

.ch-pane-plan { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.ch-views { display: flex; gap: 0; }
.ch-views button, .ch-export button {
  background: transparent; color: var(--vscode-foreground);
  border: 1px solid transparent; border-radius: 3px;
  padding: 2px 9px; cursor: pointer; font-size: 11px; font-family: inherit;
}
.ch-views button.ch-on {
  background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.18));
  border-color: var(--ch-border);
}
.ch-views button:hover, .ch-export button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
.ch-zooms { margin-left: 10px; }
.ch-zooms button { min-width: 26px; }
.ch-export { display: flex; gap: 2px; align-items: center; margin-left: auto; }
.ch-plan-body { flex: 1; display: flex; min-height: 0; }
.ch-canvas { flex: 1; overflow: auto; position: relative; cursor: grab; }

.ch-findings {
  display: none; flex: 0 0 300px; overflow: auto;
  border-left: 1px solid var(--ch-border);
  padding: 8px 10px 14px;
}
.ch-findings.ch-open { display: block; }
.ch-finding { padding: 8px 0; border-bottom: 1px solid var(--ch-border); }
.ch-finding:last-child { border-bottom: none; }
.ch-finding-title { display: flex; gap: 7px; align-items: baseline; margin-bottom: 3px; }
.ch-finding-title b { font-weight: 600; }
.ch-finding-mark { flex: 0 0 auto; font-size: 10px; line-height: 1.6; }
.ch-finding-high .ch-finding-mark { color: var(--vscode-charts-red, #f04438); }
.ch-finding-medium .ch-finding-mark { color: var(--vscode-charts-orange, #ff9900); }
.ch-finding-low .ch-finding-mark { color: var(--vscode-descriptionForeground); }
.ch-finding-evidence {
  font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground);
  font-size: 11px; margin-bottom: 4px;
}
.ch-finding-suggestion { font-size: 11px; line-height: 1.55; opacity: .92; }
.ch-findings-empty { color: var(--vscode-descriptionForeground); font-size: 11px; }
.ch-canvas.ch-panning { cursor: grabbing; }
.ch-canvas.ch-panning .ch-cell { cursor: grabbing; }
.ch-canvas svg { display: block; }

.ch-cell { cursor: pointer; }
.ch-cell rect { transition: none; }
.ch-label { pointer-events: none; }

.ch-legend {
  flex: 0 0 22px; display: flex; align-items: center; padding: 0 10px;
  border-top: 1px solid var(--ch-border);
  color: var(--vscode-descriptionForeground); font-size: 11px; opacity: .85;
}
.ch-tip-feeds { color: var(--vscode-descriptionForeground); margin-bottom: 4px; }

.ch-summary {
  display: flex; align-items: center; gap: 18px;
  height: 28px; flex: 0 0 28px; padding: 0 10px;
  border-top: 1px solid var(--ch-border);
  color: var(--vscode-descriptionForeground); font-size: 11px;
}
.ch-summary b { color: var(--vscode-foreground); font-weight: 600; }

.ch-tip {
  position: absolute; pointer-events: none; z-index: 5; max-width: 320px;
  padding: 7px 9px; border: 1px solid var(--ch-border); border-radius: 4px;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  box-shadow: 0 2px 10px rgba(0,0,0,.35); font-size: 11px; line-height: 1.6;
}
.ch-tip .ch-tip-name { font-weight: 600; margin-bottom: 3px; }
.ch-tip dl { display: grid; grid-template-columns: auto auto; gap: 1px 12px; margin: 0; }
.ch-tip dt { color: var(--vscode-descriptionForeground); }
.ch-tip dd { margin: 0; text-align: right; }

.ch-empty { padding: 24px; color: var(--vscode-descriptionForeground); max-width: 52ch; line-height: 1.6; }
`;
