/**
 * Resolving `ref()` and `source()` against dbt's own manifest.
 *
 * dbt writes `target/manifest.json` when it compiles, and that file already
 * says exactly what every `ref('users')` resolves to - which database, which
 * schema, which alias. Reading it is the difference between knowing a dbt model
 * has columns and guessing at the naming convention.
 *
 * The manifest is enormous, so only the relation names are kept. It is also
 * optional: no manifest means `ref()` stays opaque, which is the state
 * everything downstream already handles.
 */

export interface Relation {
    database?: string;
    schema?: string;
    /** The name the relation actually has in the warehouse. */
    identifier: string;
}

/** The shape of the manifest that matters here, and nothing else. */
interface ManifestNode {
    resource_type?: string;
    name?: string;
    alias?: string;
    identifier?: string;
    database?: string | null;
    schema?: string | null;
    source_name?: string;
    package_name?: string;
}

interface RawManifest {
    nodes?: Record<string, ManifestNode>;
    sources?: Record<string, ManifestNode>;
}

/** Relations a dbt project exposes, keyed the way `ref`/`source` name them. */
export class DbtManifest {
    private readonly models = new Map<string, Relation>();
    private readonly sources = new Map<string, Relation>();

    constructor(raw: unknown) {
        const manifest = (raw ?? {}) as RawManifest;

        for (const node of Object.values(manifest.nodes ?? {})) {
            // Seeds and snapshots are `ref`-able too; tests and analyses are not.
            if (!['model', 'seed', 'snapshot'].includes(node.resource_type ?? '')) continue;
            const name = node.name;
            if (!name) continue;
            this.models.set(name, relationOf(node));
        }

        for (const node of Object.values(manifest.sources ?? {})) {
            if (!node.source_name || !node.name) continue;
            this.sources.set(`${node.source_name}.${node.name}`, relationOf(node));
        }
    }

    /** What `{{ ref('name') }}` or `{{ source('a', 'b') }}` points at. */
    resolve(call: 'ref' | 'source', args: string[]): Relation | undefined {
        if (call === 'source') {
            return args.length >= 2 ? this.sources.get(`${args[args.length - 2]}.${args[args.length - 1]}`) : undefined;
        }
        // `ref('package', 'model')` names the package first.
        return this.models.get(args[args.length - 1]);
    }

    /** Every model name, for completion inside `ref('…')`. */
    modelNames(): string[] {
        return [...this.models.keys()].sort();
    }

    /** Every `source.table` pair, for completion inside `source('…')`. */
    sourceNames(): string[] {
        return [...this.sources.keys()].sort();
    }

    get size(): number {
        return this.models.size + this.sources.size;
    }
}

function relationOf(node: ManifestNode): Relation {
    const relation: Relation = { identifier: node.identifier ?? node.alias ?? node.name ?? '' };
    if (node.database) relation.database = node.database;
    if (node.schema) relation.schema = node.schema;
    return relation;
}

/**
 * Read a manifest from raw file bytes.
 *
 * A malformed or half-written manifest - dbt writes it while you might be
 * reading it - yields an empty one rather than an exception, because a missing
 * completion is a much smaller problem than a broken language server.
 */
export function parseManifest(bytes: Uint8Array): DbtManifest | undefined {
    try {
        return new DbtManifest(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return undefined;
    }
}

/**
 * The name a relation is known by in ClickHouse.
 *
 * dbt calls it `schema`; ClickHouse calls it a database, and the manifest's
 * `database` field is the connection's, which ClickHouse has no equivalent for.
 */
export function clickHouseName(relation: Relation): { database?: string; table: string } {
    const result: { database?: string; table: string } = { table: relation.identifier };
    if (relation.schema) result.database = relation.schema;
    return result;
}
