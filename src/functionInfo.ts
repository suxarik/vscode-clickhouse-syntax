/**
 * One view of a ClickHouse function, merging the curated entries with the
 * generated catalog.
 *
 * The curated table in `functionDocs.ts` covers the couple of hundred functions
 * people reach for most, with hand-tuned snippets and short examples; the
 * catalog covers everything ClickHouse actually ships. Curated fields win where
 * both have something to say.
 */
import { Catalog, CatalogArgument, CatalogFunction, functionDetail } from './catalog';
import { CH_FUNCTION_DOCS } from './functionDocs';

export interface ResolvedFunction {
    name: string;
    /** Short right-hand label for a completion row. */
    detail: string;
    signature?: string;
    snippet: string;
    aggregate: boolean;
    since?: string;
    /** Only populated by `resolveFunction`, which may read a catalog asset. */
    description?: string;
    args?: CatalogArgument[];
    returns?: string;
    example?: string;
}

function base(name: string, fn: CatalogFunction | undefined): ResolvedFunction | undefined {
    const curated = CH_FUNCTION_DOCS[name.toLowerCase()];
    if (!fn && !curated) return undefined;

    const resolved: ResolvedFunction = {
        name: fn?.name ?? curated.name,
        detail: fn ? functionDetail(fn) : (curated.category ?? 'function'),
        snippet: curated?.insertText ?? fn?.snippet ?? `${fn?.name ?? curated.name}($0)`,
        aggregate: fn?.aggregate === true || curated?.category === 'aggregate',
    };
    const signature = curated?.signature ?? fn?.syntax;
    if (signature) resolved.signature = signature;
    if (fn?.since) resolved.since = fn.since;
    return resolved;
}

/** Everything available without touching an asset file. */
export function resolveFunctionSync(name: string, catalog: Catalog): ResolvedFunction | undefined {
    const resolved = base(name, catalog.functionByName(name));
    if (!resolved) return undefined;
    const curated = CH_FUNCTION_DOCS[name.toLowerCase()];
    if (curated?.returnType) resolved.returns = curated.returnType;
    return resolved;
}

/** The full picture, reading the documentation asset if needed. */
export async function resolveFunction(name: string, catalog: Catalog): Promise<ResolvedFunction | undefined> {
    const resolved = resolveFunctionSync(name, catalog);
    if (!resolved) return undefined;

    const curated = CH_FUNCTION_DOCS[name.toLowerCase()];
    const doc = await catalog.functionDoc(resolved.name);

    resolved.description = curated?.description ?? doc?.description;
    resolved.example = curated?.example ?? doc?.example;
    resolved.returns = curated?.returnType ?? doc?.returns ?? resolved.returns;
    if (doc?.args && doc.args.length > 0) resolved.args = doc.args;
    return resolved;
}

/** Names of every function the catalog knows, plus any curated-only extras. */
export function allFunctionNames(catalog: Catalog): string[] {
    const names = new Set(catalog.functions().map(fn => fn.name));
    for (const curated of Object.values(CH_FUNCTION_DOCS)) names.add(curated.name);
    return [...names];
}
