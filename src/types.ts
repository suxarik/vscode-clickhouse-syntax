/**
 * Shared type definitions for the ClickHouse VS Code extension.
 */

export interface SchemaColumn {
    name: string;
    type: string;
    description?: string;
    defaultValue?: string;
    ttl?: string;
    codec?: string;
    comment?: string;
}

export interface SchemaTable {
    name: string;
    description?: string;
    engine?: string;
    engineOptions?: Record<string, any>;
    columns: SchemaColumn[];
    indexes?: Array<{
        name: string;
        expression: string;
        type: string;
        granularity?: number;
    }>;
    ttl?: string;
    settings?: Record<string, any>;
}

export interface SchemaDatabase {
    name: string;
    description?: string;
    tables: SchemaTable[];
}

export interface ClickHouseSchema {
    version?: string;
    databases: SchemaDatabase[];
}

export interface FunctionDoc {
    name: string;
    description: string;
    signature?: string;
    example?: string;
    insertText?: string;
    category?: string;
    parameters?: string[];
    returnType?: string;
}
