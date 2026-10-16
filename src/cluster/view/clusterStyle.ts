/**
 * What the cluster view adds to the plan view's chrome.
 *
 * The toolbar, canvas, findings pane and summary strip are the same furniture,
 * so they are the same stylesheet. Only the map itself is new.
 */
export const CLUSTER_STYLE = `
.ch-shard-label {
  fill: var(--vscode-descriptionForeground);
  font-size: 11px;
}
.ch-node { cursor: default; }
.ch-picker {
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 2px 6px; font-size: 11px; font-family: inherit; max-width: 240px;
}
.ch-refresh { margin-left: 8px; }
`;
