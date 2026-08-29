/**
 * Where a running query sends what it produces.
 *
 * The result panel was the only destination until notebooks; a notebook cell is
 * a second one. Naming the seam means the safety model, cancellation and
 * history in `QueryRunner` are written once and both destinations get them,
 * rather than a notebook growing its own quietly divergent copy.
 *
 * Free of `vscode` on purpose - the same shape is implemented on both sides.
 */
import { ColumnMeta, ResultHeader, ResultStatistics } from './protocol';

export interface SinkCallbacks {
    onCancel(): void;
}

export interface ResultSink {
    /** Which transport answered, for the diagnostic log. */
    noteTransport(name: string): void;
    begin(header: ResultHeader, callbacks: SinkCallbacks): void;
    setColumns(columns: ColumnMeta[]): void;
    appendRows(rows: unknown[][], total: number): void;
    trace(note: string): void;
    end(statistics: ResultStatistics, truncated: boolean): void;
    cancelled(): void;
    fail(message: string, code?: number): void;
}
