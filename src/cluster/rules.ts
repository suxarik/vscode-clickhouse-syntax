/**
 * What a cluster's state is worth saying out loud.
 *
 * The same shape as the query advice: a title, the measurement behind it, and
 * what to do about it. A cluster is read during an incident, so a finding that
 * cannot say which host and which table is not worth showing.
 */
import { Finding } from '../advice/types';
import { ClusterView, DataPlacement, ReplicaHealth } from './types';
import { DistributedProfile } from './distributed';

/** Below this, a delay is ordinary scheduling rather than a problem. */
const LAG_SECONDS = 30;
/** A queue this long is not draining by itself. */
const QUEUE_SIZE = 500;
/** Busiest shard against quietest, past which the key is not spreading. */
const SKEW_RATIO = 1.5;
/** Too few rows for a distribution to mean anything. */
const ENOUGH_ROWS = 10_000;
/** Replicas differ briefly while merges run; past this they have diverged. */
const DIVERGENCE = 0.05;

function duration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

function qualified(health: ReplicaHealth): string {
    return `${health.database}.${health.table}`;
}

const ORDER = { high: 0, medium: 1, low: 2 };

export function clusterFindings(view: ClusterView): Finding[] {
    const findings: Finding[] = [];

    for (const host of view.unreachable) {
        findings.push({
            ruleId: 'replica-unreachable',
            importance: 'high',
            title: `${host.host} did not answer`,
            evidence: `shard ${host.shard}, replica ${host.replica} of cluster ${host.cluster}`,
            suggestion:
                'It is configured but not reachable from this node. Distributed reads will route around it ' +
                'while it is down; inserts to it will not.',
            subject: { kind: 'table', name: host.host },
        });
    }

    // One finding per table, not per node: every replica of a degraded shard
    // reports the same shortfall, and three copies of it is noise.
    const degraded = new Map<string, ReplicaHealth>();
    for (const health of view.health) {
        if (health.activeReplicas < health.totalReplicas) degraded.set(qualified(health), health);
    }
    for (const health of degraded.values()) {
        findings.push({
            ruleId: 'shard-degraded',
            importance: 'high',
            title: `${qualified(health)} is running on fewer replicas than it has`,
            evidence: `${health.activeReplicas} of ${health.totalReplicas} replicas active`,
            suggestion:
                'The shard still serves reads and writes, with no redundancy left to lose. ' +
                'Bring the missing replica back before touching anything else.',
            subject: { kind: 'table', name: qualified(health) },
        });
    }

    for (const health of view.health) {
        if (health.isReadonly) {
            findings.push({
                ruleId: 'replica-readonly',
                importance: 'high',
                title: `${health.host} is read-only for ${qualified(health)}`,
                evidence: `read-only for ${duration(health.readonlySeconds)}`,
                suggestion:
                    'A replica goes read-only when it loses Keeper. It accepts no writes until the session ' +
                    'returns, and the others carry the load meanwhile.',
                subject: { kind: 'table', name: qualified(health) },
            });
        }

        if (health.sessionExpired) {
            findings.push({
                ruleId: 'session-expired',
                importance: 'high',
                title: `${health.host} has lost its Keeper session`,
                evidence: `${qualified(health)} reports an expired session`,
                suggestion: 'Replication stops until the session is re-established. Check Keeper before the replica.',
                subject: { kind: 'table', name: qualified(health) },
            });
        }

        if (health.lostParts > 0) {
            findings.push({
                ruleId: 'lost-parts',
                importance: 'high',
                title: `${qualified(health)} has lost parts on ${health.host}`,
                evidence: `${health.lostParts} part(s) recorded as lost`,
                suggestion:
                    'A lost part does not come back on its own. The data is on another replica, or it is gone.',
                subject: { kind: 'table', name: qualified(health) },
            });
        }

        if (health.absoluteDelaySeconds >= LAG_SECONDS) {
            findings.push({
                ruleId: 'replication-lag',
                importance: health.absoluteDelaySeconds > 600 ? 'high' : 'medium',
                title: `${health.host} is behind on ${qualified(health)}`,
                evidence: `${health.absoluteDelaySeconds}s behind (${duration(health.absoluteDelaySeconds)})`,
                suggestion:
                    'Reads from this replica return older rows than reads from the others. ' +
                    'A distributed read may hit either.',
                subject: { kind: 'table', name: qualified(health) },
            });
        }

        if (health.queueSize >= QUEUE_SIZE) {
            findings.push({
                ruleId: 'replication-queue',
                importance: 'medium',
                title: `${health.host} has a replication queue that is not draining`,
                evidence: `${health.queueSize} entries queued for ${qualified(health)}`,
                suggestion:
                    'Look at system.replication_queue for what is stuck and why; one failing entry holds up the rest.',
                subject: { kind: 'table', name: qualified(health) },
            });
        }
    }

    findings.push(...placementFindings(view.placement));
    return findings.sort((a, b) => ORDER[a.importance] - ORDER[b.importance]);
}

function percent(part: number, whole: number): string {
    return `${((100 * part) / (whole || 1)).toFixed(1)}%`;
}

/**
 * What the sharding key actually did, and whether the replicas agree.
 *
 * Both are things no single node can see: each one looks perfectly healthy
 * holding whatever share it was given.
 */
function placementFindings(placement: DataPlacement[]): Finding[] {
    const findings: Finding[] = [];
    const byTable = new Map<string, DataPlacement[]>();
    for (const entry of placement) {
        const key = `${entry.database}.${entry.table}`;
        byTable.set(key, [...(byTable.get(key) ?? []), entry]);
    }

    for (const [table, entries] of byTable) {
        // One replica per shard, so a shard is not counted twice — and the
        // largest, so a replica still catching up does not look like a shard.
        const perShard = new Map<string, number>();
        for (const entry of entries) {
            perShard.set(entry.shard, Math.max(perShard.get(entry.shard) ?? 0, entry.rows));
        }

        const counts = [...perShard.values()];
        const total = counts.reduce((sum, rows) => sum + rows, 0);
        if (perShard.size >= 2 && total >= ENOUGH_ROWS) {
            const most = Math.max(...counts);
            const least = Math.min(...counts);
            if (least > 0 && most / least >= SKEW_RATIO) {
                const busiest = [...perShard.entries()].sort((a, b) => b[1] - a[1])[0];
                findings.push({
                    ruleId: 'shard-skew',
                    importance: 'medium',
                    title: `${table} is spread unevenly across its shards`,
                    evidence:
                        `shard ${busiest[0]} holds ${percent(busiest[1], total)} of ${perShard.size} shards ` +
                        `(${most.toLocaleString('en-US')} rows against ${least.toLocaleString('en-US')})`,
                    suggestion:
                        'The sharding key is not dividing the rows. A key with few distinct values cannot ' +
                        'spread across more shards than it has values, and the cluster is then only as fast ' +
                        'as its busiest node.',
                    subject: { kind: 'table', name: table },
                });
            }
        }

        // Replicas of one shard hold the same rows, or one of them is wrong.
        for (const [shard] of perShard) {
            const replicas = entries.filter(entry => entry.shard === shard);
            if (replicas.length < 2) continue;

            const most = replicas.reduce((best, entry) => (entry.rows > best.rows ? entry : best));
            const least = replicas.reduce((worst, entry) => (entry.rows < worst.rows ? entry : worst));
            if (most.rows === 0 || (most.rows - least.rows) / most.rows < DIVERGENCE) continue;

            findings.push({
                ruleId: 'replica-divergence',
                importance: 'high',
                title: `Replicas of shard ${shard} disagree about ${table}`,
                evidence:
                    `${most.host} holds ${most.rows.toLocaleString('en-US')} rows, ` +
                    `${least.host} holds ${least.rows.toLocaleString('en-US')}`,
                suggestion:
                    'Replicas of one shard hold the same data. A gap this size means one is behind, ' +
                    'or has lost parts the other still has.',
                subject: { kind: 'table', name: table },
            });
        }
    }

    return findings;
}

/**
 * What one distributed query asked of each shard.
 *
 * Uneven work here and uneven data placement are the same fault seen twice —
 * but a query can be skewed on well-spread data too, when its filter matches
 * rows that happen to live together.
 */
export function distributedFindings(profile: DistributedProfile): Finding[] {
    if (profile.shards.length < 2 || profile.skew < SKEW_RATIO) return [];

    const busiest = [...profile.shards].sort((a, b) => b.readRows - a.readRows)[0];
    const quietest = [...profile.shards].sort((a, b) => a.readRows - b.readRows)[0];

    return [
        {
            ruleId: 'shard-work-skew',
            importance: 'medium',
            title: 'The shards did very different amounts of work',
            evidence:
                `shard ${busiest.shard} read ${busiest.readRows.toLocaleString('en-US')} rows, ` +
                `shard ${quietest.shard} read ${quietest.readRows.toLocaleString('en-US')} ` +
                `(${profile.skew.toFixed(1)}x)`,
            suggestion:
                'A distributed query is only as quick as its slowest shard, so the busiest one sets the time. ' +
                'Either the sharding key does not divide the table, or this filter matches rows that live together.',
        },
    ];
}
