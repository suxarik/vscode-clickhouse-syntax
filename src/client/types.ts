/**
 * Connection and query types.
 */

export interface ConnectionProfile {
    name: string;
    host: string;
    port?: number;
    protocol?: 'http' | 'https';
    user?: string;
    database?: string;
    /** Without this the profile refuses anything that is not a read. */
    allowWrite?: boolean;
    /** Writes on a protected profile need the profile name typed to confirm. */
    protected?: boolean;
    /** Extra settings sent with every query on this profile. */
    settings?: Record<string, string | number | boolean>;
}

/** A profile with defaults applied and secrets resolved. */
export interface ResolvedConnection {
    name: string;
    /** Base URL, no trailing slash. */
    url: string;
    user: string;
    password?: string;
    database: string;
    allowWrite: boolean;
    isProtected: boolean;
    settings: Record<string, string | number | boolean>;
}

export interface ColumnMeta {
    name: string;
    type: string;
}

export interface QuerySummary {
    readRows?: number;
    readBytes?: number;
    writtenRows?: number;
    writtenBytes?: number;
    totalRowsToRead?: number;
    resultRows?: number;
    resultBytes?: number;
}

export interface QueryResult {
    queryId: string;
    columns: ColumnMeta[];
    rows: unknown[][];
    /** True when `maxRows` stopped the read before the server ran out of rows. */
    truncated: boolean;
    /** Wall-clock milliseconds measured by the client. */
    elapsedMs: number;
    /** Server-reported counters, when ClickHouse sent them. */
    summary?: QuerySummary;
}

export class ClickHouseError extends Error {
    constructor(
        message: string,
        /** ClickHouse error code, e.g. 60 for UNKNOWN_TABLE. */
        readonly code?: number,
        readonly httpStatus?: number
    ) {
        super(message);
        this.name = 'ClickHouseError';
    }
}
