/**
 * Access layer over the generated ClickHouse catalog.
 *
 * The catalog comes in two tiers. Everything needed on the keystroke path —
 * function names, signatures, setting names, formats, types, engines — is
 * bundled and parsed lazily on first use. Prose (function documentation,
 * setting descriptions, the `system` database) lives in JSON assets that are
 * read from disk only when something actually asks for them, so activation
 * costs nothing.
 */
import * as vscode from 'vscode';
import { catalogFunctions } from './generated/functions';
import { catalogDataTypes } from './generated/dataTypes';
import { catalogEngines } from './generated/engines';
import { catalogSettings } from './generated/settings';
import { catalogFormats } from './generated/formats';
import { catalogKeywords } from './generated/keywords';
import { CATALOG_VERSION, CATALOG_GENERATED_AT, CATALOG_COUNTS } from './generated/meta';
import {
    CatalogArgument,
    CatalogDataType,
    CatalogEngine,
    CatalogFormat,
    CatalogFunction,
    CatalogSetting,
    CatalogSystemTable,
} from './types';

export * from './types';
export { CATALOG_VERSION, CATALOG_GENERATED_AT, CATALOG_COUNTS };

export interface CatalogFunctionDoc {
    description?: string;
    args?: CatalogArgument[];
    returns?: string;
    example?: string;
}

const ASSET_DIR = 'catalog';

/** `"23.8"` / `"23.8.1.2"` → comparable tuple. */
function parseVersion(version: string): number[] {
    return version
        .split(/[.\-+]/)
        .map(part => Number.parseInt(part, 10))
        .filter(part => Number.isFinite(part));
}

/** Negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

export class Catalog {
    private functionIndex?: Map<string, CatalogFunction>;
    private settingIndex?: Map<string, CatalogSetting>;
    private formatIndex?: Map<string, CatalogFormat>;
    private dataTypeIndex?: Map<string, CatalogDataType>;
    private engineIndex?: Map<string, CatalogEngine>;

    private functionDocs?: Promise<Record<string, CatalogFunctionDoc>>;
    private settingDocs?: Promise<Record<string, string>>;
    private systemTablesPromise?: Promise<CatalogSystemTable[]>;
    private systemTableIndex?: Map<string, CatalogSystemTable>;

    constructor(private readonly extensionUri: vscode.Uri) {}

    readonly version = CATALOG_VERSION;
    readonly generatedAt = CATALOG_GENERATED_AT;
    readonly counts = CATALOG_COUNTS;

    // ── Bundled tier ─────────────────────────────────────────────────────────

    functions(): CatalogFunction[] {
        return catalogFunctions();
    }

    functionByName(name: string): CatalogFunction | undefined {
        if (!this.functionIndex) {
            this.functionIndex = new Map();
            for (const fn of catalogFunctions()) {
                // Case-insensitive lookup, but the canonical spelling wins a clash.
                const key = fn.name.toLowerCase();
                if (!this.functionIndex.has(key)) this.functionIndex.set(key, fn);
            }
        }
        return this.functionIndex.get(name.toLowerCase());
    }

    settings(): CatalogSetting[] {
        return catalogSettings();
    }

    settingByName(name: string): CatalogSetting | undefined {
        if (!this.settingIndex) {
            this.settingIndex = new Map();
            for (const setting of catalogSettings()) {
                const key = setting.name.toLowerCase();
                if (!this.settingIndex.has(key)) this.settingIndex.set(key, setting);
            }
        }
        return this.settingIndex.get(name.toLowerCase());
    }

    formats(): CatalogFormat[] {
        return catalogFormats();
    }

    formatByName(name: string): CatalogFormat | undefined {
        if (!this.formatIndex) {
            this.formatIndex = new Map(catalogFormats().map(f => [f.name.toLowerCase(), f]));
        }
        return this.formatIndex.get(name.toLowerCase());
    }

    dataTypes(): CatalogDataType[] {
        return catalogDataTypes();
    }

    dataTypeByName(name: string): CatalogDataType | undefined {
        if (!this.dataTypeIndex) {
            this.dataTypeIndex = new Map(catalogDataTypes().map(t => [t.name.toLowerCase(), t]));
        }
        return this.dataTypeIndex.get(name.toLowerCase());
    }

    engines(): CatalogEngine[] {
        return catalogEngines();
    }

    engineByName(name: string): CatalogEngine | undefined {
        if (!this.engineIndex) {
            this.engineIndex = new Map(catalogEngines().map(e => [e.name.toLowerCase(), e]));
        }
        return this.engineIndex.get(name.toLowerCase());
    }

    keywords(): string[] {
        return catalogKeywords();
    }

    // ── Lazily-read assets ───────────────────────────────────────────────────

    private async readAsset<T>(file: string, fallback: T): Promise<T> {
        try {
            const uri = vscode.Uri.joinPath(this.extensionUri, ASSET_DIR, file);
            const bytes = await vscode.workspace.fs.readFile(uri);
            return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
        } catch (err) {
            console.error(`ClickHouse: could not read catalog asset ${file}`, err);
            return fallback;
        }
    }

    async functionDoc(name: string): Promise<CatalogFunctionDoc | undefined> {
        if (!this.functionDocs) {
            this.functionDocs = this.readAsset<Record<string, CatalogFunctionDoc>>('function-docs.json', {});
        }
        const docs = await this.functionDocs;
        const canonical = this.functionByName(name);
        return docs[canonical?.name ?? name] ?? docs[name];
    }

    async settingDoc(name: string): Promise<string | undefined> {
        if (!this.settingDocs) {
            this.settingDocs = this.readAsset<Record<string, string>>('setting-docs.json', {});
        }
        const docs = await this.settingDocs;
        return docs[this.settingByName(name)?.name ?? name];
    }

    async systemTables(): Promise<CatalogSystemTable[]> {
        if (!this.systemTablesPromise) {
            this.systemTablesPromise = this.readAsset<CatalogSystemTable[]>('system-tables.json', []);
        }
        return this.systemTablesPromise;
    }

    async systemTable(name: string): Promise<CatalogSystemTable | undefined> {
        const tables = await this.systemTables();
        if (!this.systemTableIndex) {
            this.systemTableIndex = new Map(tables.map(t => [t.name.toLowerCase(), t]));
        }
        return this.systemTableIndex.get(name.toLowerCase());
    }

    /** Warm the assets in the background so the first hover is not the one that pays. */
    preload(): void {
        void this.functionDoc('count');
        void this.systemTables();
    }
}

/**
 * Whether a catalog entry exists on the configured server version.
 * Unknown or unset versions allow everything through.
 */
export function isAvailableIn(since: string | undefined, serverVersion: string | undefined): boolean {
    if (!since || !serverVersion || serverVersion === 'auto') return true;
    return compareVersions(serverVersion, since) >= 0;
}

/** Human-readable label for a function's category. */
export function functionDetail(fn: CatalogFunction): string {
    const parts: string[] = [];
    if (fn.aggregate) parts.push('aggregate');
    else if (fn.category) parts.push(fn.category.toLowerCase());
    else parts.push(fn.group);
    if (fn.aliasTo) parts.push(`alias of ${fn.aliasTo}`);
    if (fn.since) parts.push(`since ${fn.since}`);
    return parts.join(' · ');
}
