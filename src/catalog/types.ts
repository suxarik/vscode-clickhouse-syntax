/**
 * Shapes of the generated ClickHouse catalog.
 *
 * Every field here comes from the server's own introspection tables — see
 * scripts/generate-catalog.mjs. Optional fields are omitted rather than set to
 * null so the shipped JSON stays compact.
 */

/** Coarse grouping used for grammar scopes and completion detail rows. */
export type FunctionGroup =
    | 'aggregate'
    | 'array'
    | 'string'
    | 'date'
    | 'math'
    | 'type'
    | 'conditional'
    | 'other';

export interface CatalogArgument {
    name: string;
    description?: string;
}

export interface CatalogFunction {
    name: string;
    group: FunctionGroup;
    /** Primary category as ClickHouse reports it, e.g. `"Type Conversion"`. */
    category?: string;
    aggregate?: true;
    caseInsensitive?: true;
    higherOrder?: true;
    nonDeterministic?: true;
    /** Set when this name is an alias for another function. */
    aliasTo?: string;
    description?: string;
    syntax?: string;
    args?: CatalogArgument[];
    returns?: string;
    example?: string;
    /** ClickHouse version that introduced the function, e.g. `"23.8"`. */
    since?: string;
    /** Snippet body for completion, e.g. `arrayMap(${1:func}, ${2:arr})`. */
    snippet: string;
}

export interface CatalogDataType {
    name: string;
    caseInsensitive?: true;
    aliasTo?: string;
}

export type EngineCapability =
    | 'sortOrder'
    | 'ttl'
    | 'skippingIndices'
    | 'replication'
    | 'deduplication'
    | 'settings'
    | 'parallelInsert';

export interface CatalogEngine {
    name: string;
    supports?: EngineCapability[];
}

export interface CatalogSetting {
    name: string;
    type: string;
    default?: string;
    description?: string;
    /** Non-production settings are marked, e.g. `Experimental`, `Beta`. */
    tier?: string;
    /** True for `system.merge_tree_settings` entries. */
    mergeTree?: true;
}

export interface CatalogFormat {
    name: string;
    input?: true;
    output?: true;
}

export interface CatalogSystemColumn {
    name: string;
    type: string;
    comment?: string;
}

export interface CatalogSystemTable {
    name: string;
    engine: string;
    comment?: string;
    columns: CatalogSystemColumn[];
}
