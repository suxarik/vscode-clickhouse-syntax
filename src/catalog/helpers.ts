/**
 * Pure catalog helpers.
 *
 * Deliberately free of any `vscode` import so build scripts and the lint rules
 * can use them without pulling in the extension host.
 */
import { CatalogFunction } from './types';

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
