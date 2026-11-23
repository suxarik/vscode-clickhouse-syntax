/**
 * What a server's storage state is worth saying out loud.
 *
 * The same shape as the cluster and query advice: a title, the measurement
 * behind it, and what to do. One finding per table, not per partition or per
 * mutation — a table with forty partitions over the limit has one problem, and
 * forty cards for it hide the other tables that have their own.
 */
import { Finding } from '../advice/types';
import { formatBytes } from '../results/format';
import { HealthView } from './types';

/** How near a limit counts as "about to hit it". */
const NEAR = 0.8;
/** Many parts is only worth a word when they are also tiny. */
const MANY_PARTS = 100;
const SMALL_PART_BYTES = 1024 * 1024;
/** A mutation that has run this long without failing is slow, not stuck. */
const SLOW_MUTATION_SECONDS = 3600;
const LONG_MERGE_SECONDS = 3600;
/** Free-space fractions below which a disk is worth a word. */
const DISK_CRITICAL = 0.1;
const DISK_LOW = 0.2;
/** Detach reasons that mean ClickHouse itself gave up on the part. */
const BROKEN_REASON = /broken|unexpected|covered|noquorum|ignored/i;

const ORDER = { high: 0, medium: 1, low: 2 };

function duration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
    return `${Math.floor(seconds / 86_400)}d ${Math.round((seconds % 86_400) / 3600)}h`;
}

const qualified = (database: string, table: string): string => `${database}.${table}`;

function percent(part: number, whole: number): string {
    return `${((part / whole) * 100).toFixed(1)}%`;
}

export function healthFindings(view: HealthView): Finding[] {
    const findings: Finding[] = [];
    const { delayAt, throwAt } = view.limits;

    // Parts: per partition is how ClickHouse counts, per table is how a person acts.
    const worst = new Map<string, HealthView['partitions'][number]>();
    for (const partition of view.partitions) {
        const key = qualified(partition.database, partition.table);
        const seen = worst.get(key);
        if (!seen || partition.parts > seen.parts) worst.set(key, partition);
    }
    for (const [name, partition] of worst) {
        const where = `partition ${partition.partition || '(none)'}`;
        const average = partition.parts > 0 ? partition.bytes / partition.parts : 0;
        const subject = { kind: 'table' as const, name };

        if (partition.parts >= throwAt * NEAR) {
            findings.push({
                ruleId: 'parts-near-throw',
                importance: 'high',
                title: `${name} is close to refusing inserts`,
                evidence: `${partition.parts} active parts in ${where}; inserts fail with TOO_MANY_PARTS at ${throwAt}`,
                suggestion:
                    'Merges are not keeping up with inserts. Stop or batch the writers, and check for a stuck ' +
                    'mutation or a merge that is running for hours — either blocks the merges that would reduce this.',
                subject,
            });
        } else if (partition.parts >= delayAt * NEAR) {
            findings.push({
                ruleId: 'parts-near-delay',
                importance: 'medium',
                title: `${name} has a lot of parts`,
                evidence: `${partition.parts} active parts in ${where}; inserts are slowed from ${delayAt}`,
                suggestion:
                    'Every insert past that point is delayed on purpose. Insert in larger batches, or turn on ' +
                    'async_insert so the server forms the batches.',
                subject,
            });
        } else if (partition.parts >= MANY_PARTS && average < SMALL_PART_BYTES) {
            findings.push({
                ruleId: 'many-small-parts',
                importance: 'low',
                title: `${name} is made of many small parts`,
                evidence: `${partition.parts} parts in ${where}, averaging ${formatBytes(Math.round(average))}`,
                suggestion:
                    'Small parts are what frequent small inserts leave behind. Merges will fold them in, but ' +
                    'each insert is cheaper and the table faster to read when the batches are bigger.',
                subject,
            });
        }
    }

    // Mutations: one per table, the most telling one.
    const byTable = new Map<string, HealthView['mutations'][number][]>();
    for (const mutation of view.mutations) {
        const key = qualified(mutation.database, mutation.table);
        byTable.set(key, [...(byTable.get(key) ?? []), mutation]);
    }
    for (const [name, mutations] of byTable) {
        const failing = mutations.find(mutation => mutation.failReason);
        const subject = { kind: 'table' as const, name };
        if (failing) {
            findings.push({
                ruleId: 'mutation-stuck',
                importance: 'high',
                title: `A mutation on ${name} keeps failing`,
                evidence:
                    `${failing.id} (${failing.command.slice(0, 80)}) pending for ${duration(failing.ageSeconds)}, ` +
                    `${failing.partsToDo} parts to go. Last error: ${failing.failReason.slice(0, 200)}`,
                suggestion:
                    `It retries forever and holds back merges on the parts it touches. Fix what the error names, ` +
                    `or give up on it: KILL MUTATION WHERE database = '${failing.database}' AND ` +
                    `table = '${failing.table}' AND mutation_id = '${failing.id}'.`,
                subject,
            });
            continue;
        }
        const oldest = mutations.reduce((a, b) => (b.ageSeconds > a.ageSeconds ? b : a));
        if (oldest.ageSeconds >= SLOW_MUTATION_SECONDS) {
            findings.push({
                ruleId: 'mutation-slow',
                importance: 'medium',
                title: `A mutation on ${name} has been running a long time`,
                evidence: `${oldest.id} pending for ${duration(oldest.ageSeconds)}, ${oldest.partsToDo} parts to go`,
                suggestion:
                    'No error, so it is working — but a mutation rewrites every part it touches. Check that it ' +
                    'is moving: the parts to go should fall between looks.',
                subject,
            });
        }
    }

    // Merges: a long one is only a worry when it is still a long way from done.
    for (const merge of view.merges) {
        if (merge.elapsedSeconds < LONG_MERGE_SECONDS) continue;
        const name = qualified(merge.database, merge.table);
        findings.push({
            ruleId: 'merge-long',
            importance: 'low',
            title: `A ${merge.isMutation ? 'mutation' : 'merge'} on ${name} has run for ${duration(merge.elapsedSeconds)}`,
            evidence: `${percent(merge.progress, 1)} done, ${merge.numParts} parts, ${formatBytes(merge.bytes)} compressed`,
            suggestion:
                'Big merges are normal. It matters if progress has not moved since the last look, or if the ' +
                'table is also near its part limit, since new parts then pile up behind it.',
            subject: { kind: 'table', name },
        });
    }

    for (const disk of view.disks) {
        const free = disk.freeBytes / disk.totalBytes;
        if (free >= DISK_LOW) continue;
        findings.push({
            ruleId: 'disk-low',
            importance: free < DISK_CRITICAL ? 'high' : 'medium',
            title: `Disk ${disk.name} is ${free < DISK_CRITICAL ? 'nearly full' : 'getting full'}`,
            evidence: `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)} (${percent(disk.freeBytes, disk.totalBytes)})`,
            suggestion:
                'Merges need room to write the new part before the old ones go, so a full disk stops them and ' +
                'the part count climbs. Drop old partitions, add a TTL, or add capacity.',
        });
    }

    // Detached parts, per table and worst reason.
    const detached = new Map<string, HealthView['detached'][number][]>();
    for (const group of view.detached) {
        const key = qualified(group.database, group.table);
        detached.set(key, [...(detached.get(key) ?? []), group]);
    }
    for (const [name, groups] of detached) {
        const total = groups.reduce((sum, group) => sum + group.parts, 0);
        const broken = groups.filter(group => BROKEN_REASON.test(group.reason));
        const evidence = groups
            .map(group => `${group.parts} ${group.reason ? `“${group.reason}”` : 'detached by hand'}`)
            .join(', ');
        findings.push({
            ruleId: broken.length > 0 ? 'detached-broken' : 'detached-parts',
            importance: broken.length > 0 ? 'high' : 'low',
            title:
                broken.length > 0
                    ? `${name} has parts ClickHouse set aside`
                    : `${name} has ${total} detached ${total === 1 ? 'part' : 'parts'}`,
            evidence,
            suggestion:
                broken.length > 0
                    ? 'The server detached these itself, usually after corruption or an unclean stop. Their rows are ' +
                      'not in the table. On a replicated table the missing data is fetched again; on a plain one it ' +
                      'is gone unless the part can be attached back.'
                    : 'Someone detached these. They take disk and are not queried; ATTACH them back or DROP DETACHED ' +
                      'once they are no longer wanted.',
            subject: { kind: 'table', name },
        });
    }

    return findings.sort((a, b) => ORDER[a.importance] - ORDER[b.importance]);
}
