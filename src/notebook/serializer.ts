/**
 * The bridge between the file format and VS Code's notebook model.
 *
 * All the interesting logic is in `format.ts`, which knows nothing about
 * `vscode`; this file only translates. Note what it does *not* do: outputs
 * never reach `serializeNotebook`, because the format has nowhere to put them.
 * That is what makes "results are never written to disk" a property of the
 * format rather than a promise about the code.
 */
import * as vscode from 'vscode';
import { markerFor, parseCells, TextCell, writeCells } from './format';

export const NOTEBOOK_TYPE = 'clickhouse-notebook';

/** Where the marker and spacing of a cell are remembered between saves. */
interface CellMetadata {
    marker?: string;
    trailingBlankLines?: number;
}

export class ClickHouseNotebookSerializer implements vscode.NotebookSerializer {
    deserializeNotebook(content: Uint8Array): vscode.NotebookData {
        const text = new TextDecoder().decode(content);
        const cells = parseCells(text).map(cell => {
            const data = new vscode.NotebookCellData(
                cell.kind === 'markup' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
                cell.value,
                cell.kind === 'markup' ? 'markdown' : 'clickhouse'
            );
            const metadata: CellMetadata = { trailingBlankLines: cell.trailingBlankLines };
            if (cell.marker !== undefined) metadata.marker = cell.marker;
            data.metadata = metadata;
            return data;
        });
        return new vscode.NotebookData(cells);
    }

    serializeNotebook(data: vscode.NotebookData): Uint8Array {
        const cells: TextCell[] = data.cells.map((cell, index) => {
            const metadata = (cell.metadata ?? {}) as CellMetadata;
            const kind = cell.kind === vscode.NotebookCellKind.Markup ? 'markup' : 'code';
            const text: TextCell = {
                kind,
                value: cell.value,
                // A cell that ends the file needs no blank line after it; one in
                // the middle gets the one it had, or a single separator.
                trailingBlankLines:
                    metadata.trailingBlankLines ?? (index === data.cells.length - 1 ? 0 : 1),
            };
            if (metadata.marker !== undefined) text.marker = metadata.marker;
            const marker = markerFor(text);
            if (marker !== undefined) text.marker = marker;
            else delete text.marker;
            return text;
        });
        return new TextEncoder().encode(writeCells(cells));
    }
}
