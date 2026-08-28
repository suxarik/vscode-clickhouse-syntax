/**
 * The wire between the result view and whatever hosts it.
 *
 * Deliberately free of any `vscode` import: the view runs in a webview panel
 * today and will run as a notebook output renderer later, and those are
 * different sandboxes with different messaging APIs. Everything either side
 * needs to agree on lives here.
 */

export interface ColumnMeta {
    name: string;
    type: string;
}

export interface ResultStatistics {
    elapsedMs?: number;
    readRows?: number;
    readBytes?: number;
    resultRows?: number;
    writtenRows?: number;
}

export interface ResultHeader {
    /** The statement, for the title bar. Already trimmed. */
    query: string;
    /** Profile the query ran against. */
    profile: string;
    columns: ColumnMeta[];
    queryId: string;
}

/** Host → view. */
export type HostMessage =
    | { type: 'begin'; header: ResultHeader }
    | { type: 'rows'; rows: unknown[][]; total: number }
    | { type: 'end'; statistics: ResultStatistics; truncated: boolean }
    | { type: 'error'; message: string; code?: number }
    | { type: 'cancelled' };

/** View → host. */
export type ViewMessage =
    | { type: 'ready' }
    | { type: 'cancel' }
    | { type: 'copy'; format: SerializationFormat; scope: 'all' | 'selection'; selection?: CellRange }
    | { type: 'export'; format: SerializationFormat };

export interface CellRange {
    fromRow: number;
    toRow: number;
    fromColumn: number;
    toColumn: number;
}

export type SerializationFormat = 'tsv' | 'csv' | 'json' | 'markdown';
