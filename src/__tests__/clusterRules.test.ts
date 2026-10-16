/**
 * Tests for what a cluster's state is worth saying out loud.
 */
import { clusterFindings, distributedFindings } from '../cluster/rules';
import { ClusterHost, ClusterView, DataPlacement, ReplicaHealth } from '../cluster/types';

const host = (shard: number, replica: number, name: string): ClusterHost => ({
    cluster: 'analytics',
    shard,
    replica,
    host: name,
    port: 9000,
    isLocal: shard === 1 && replica === 1,
    errors: 0,
    slowdowns: 0,
    estimatedRecoverySeconds: 0,
});

const healthy = (name: string, over: Partial<ReplicaHealth> = {}): ReplicaHealth => ({
    host: name,
    database: 'demo',
    table: 'events_local',
    isReadonly: false,
    readonlySeconds: 0,
    sessionExpired: false,
    absoluteDelaySeconds: 0,
    queueSize: 0,
    totalReplicas: 2,
    activeReplicas: 2,
    lostParts: 0,
    ...over,
});

const view = (over: Partial<ClusterView> = {}): ClusterView => ({
    cluster: 'analytics',
    hosts: [host(1, 1, 'ch-01'), host(1, 2, 'ch-02'), host(2, 1, 'ch-03'), host(2, 2, 'ch-04')],
    health: ['ch-01', 'ch-02', 'ch-03', 'ch-04'].map(name => healthy(name)),
    unreachable: [],
    placement: [],
    ...over,
});

const placed = (shard: string, host: string, rows: number, table = 'events_local'): DataPlacement => ({
    shard,
    host,
    database: 'demo',
    table,
    rows,
    bytes: rows * 20,
    parts: 3,
});

describe('clusterFindings', () => {
    it('says nothing about a cluster that is fine', () => {
        expect(clusterFindings(view())).toEqual([]);
    });

    it('reports a host that did not answer, and which shard it leaves short', () => {
        const findings = clusterFindings(
            view({ unreachable: [host(2, 2, 'ch-04')], health: ['ch-01', 'ch-02', 'ch-03'].map(n => healthy(n)) })
        );
        const finding = findings.find(f => f.ruleId === 'replica-unreachable');

        expect(finding?.title).toContain('ch-04');
        expect(finding?.evidence).toContain('shard 2');
        expect(finding?.importance).toBe('high');
    });

    it('reports a shard running on fewer replicas than it has', () => {
        const findings = clusterFindings(
            view({ health: [healthy('ch-03', { activeReplicas: 1 })] })
        );
        const finding = findings.find(f => f.ruleId === 'shard-degraded');
        expect(finding?.evidence).toContain('1 of 2');
    });

    it('reports a read-only replica, and how long it has been one', () => {
        const findings = clusterFindings(
            view({ health: [healthy('ch-02', { isReadonly: true, readonlySeconds: 15_120 })] })
        );
        const finding = findings.find(f => f.ruleId === 'replica-readonly');

        expect(finding?.title).toContain('ch-02');
        expect(finding?.evidence).toMatch(/4h|15120/);
        expect(finding?.importance).toBe('high');
    });

    it('reports replication that has fallen behind', () => {
        const findings = clusterFindings(view({ health: [healthy('ch-02', { absoluteDelaySeconds: 340 })] }));
        expect(findings.find(f => f.ruleId === 'replication-lag')?.evidence).toContain('340');
    });

    it('ignores a delay too small to mean anything', () => {
        const findings = clusterFindings(view({ health: [healthy('ch-02', { absoluteDelaySeconds: 2 })] }));
        expect(findings.map(f => f.ruleId)).not.toContain('replication-lag');
    });

    it('reports a replication queue that is not draining', () => {
        const findings = clusterFindings(view({ health: [healthy('ch-02', { queueSize: 4200 })] }));
        expect(findings.find(f => f.ruleId === 'replication-queue')?.evidence).toContain('4200');
    });

    it('reports lost parts, which do not come back on their own', () => {
        const findings = clusterFindings(view({ health: [healthy('ch-03', { lostParts: 3 })] }));
        const finding = findings.find(f => f.ruleId === 'lost-parts');
        expect(finding?.importance).toBe('high');
    });

    it('reports a replica whose Keeper session has gone', () => {
        const findings = clusterFindings(view({ health: [healthy('ch-02', { sessionExpired: true })] }));
        expect(findings.map(f => f.ruleId)).toContain('session-expired');
    });

    it('puts the worst first', () => {
        const findings = clusterFindings(
            view({
                unreachable: [host(2, 2, 'ch-04')],
                health: [healthy('ch-02', { absoluteDelaySeconds: 400 })],
            })
        );
        expect(findings[0].importance).toBe('high');
    });

    it('names one finding per table rather than one per node for the same fault', () => {
        const findings = clusterFindings(
            view({
                health: [
                    healthy('ch-01', { activeReplicas: 1 }),
                    healthy('ch-02', { activeReplicas: 1 }),
                ],
            })
        );
        expect(findings.filter(f => f.ruleId === 'shard-degraded')).toHaveLength(1);
    });
});


describe('clusterFindings about where the data is', () => {
    it('says nothing when the shards hold about the same', () => {
        const findings = clusterFindings(
            view({ placement: [placed('1', 'ch-01', 1_001_760), placed('2', 'ch-03', 998_240)] })
        );
        expect(findings.map(f => f.ruleId)).not.toContain('shard-skew');
    });

    it('reports a sharding key that does not spread', () => {
        // Three distinct values across two shards cannot divide evenly.
        const findings = clusterFindings(
            view({
                placement: [
                    placed('1', 'ch-01', 800_000, 'skewed_local'),
                    placed('2', 'ch-03', 400_000, 'skewed_local'),
                ],
            })
        );
        const finding = findings.find(f => f.ruleId === 'shard-skew');

        expect(finding?.title).toContain('skewed_local');
        expect(finding?.evidence).toMatch(/67|66/);
        expect(finding?.suggestion).toContain('sharding key');
    });

    it('ignores a table too small for its distribution to mean anything', () => {
        const findings = clusterFindings(
            view({ placement: [placed('1', 'ch-01', 900, 'tiny'), placed('2', 'ch-03', 100, 'tiny')] })
        );
        expect(findings.map(f => f.ruleId)).not.toContain('shard-skew');
    });

    it('reports two replicas of one shard holding different amounts', () => {
        const findings = clusterFindings(
            view({ placement: [placed('1', 'ch-01', 1_000_000), placed('1', 'ch-02', 600_000)] })
        );
        const finding = findings.find(f => f.ruleId === 'replica-divergence');

        expect(finding?.evidence).toContain('ch-02');
        expect(finding?.importance).toBe('high');
    });

    it('allows the small difference a merge in flight produces', () => {
        const findings = clusterFindings(
            view({ placement: [placed('1', 'ch-01', 1_000_000), placed('1', 'ch-02', 999_000)] })
        );
        expect(findings.map(f => f.ruleId)).not.toContain('replica-divergence');
    });

    it('does not call a shard skewed because one of its replicas is missing', () => {
        // ch-04 is down, so shard 2 reports only ch-03. That is a reachability
        // problem, already reported, and not a distribution one.
        const findings = clusterFindings(
            view({
                placement: [
                    placed('1', 'ch-01', 1_000_000),
                    placed('1', 'ch-02', 1_000_000),
                    placed('2', 'ch-03', 1_000_000),
                ],
            })
        );
        expect(findings.map(f => f.ruleId)).not.toContain('shard-skew');
    });
});

describe('distributedFindings', () => {
    const work = (shard: string, rows: number, initiator = false) => ({
        shard,
        host: `ch-0${shard}`,
        isInitiator: initiator,
        durationMs: 100,
        readRows: rows,
        readBytes: rows * 10,
        memoryBytes: 1,
    });

    it('reports shards that did very different amounts of work', () => {
        const finding = distributedFindings({
            shards: [work('1', 800_000, true), work('2', 400_000)],
            totalReadRows: 1_200_000,
            skew: 2,
        })[0];

        expect(finding.ruleId).toBe('shard-work-skew');
        expect(finding.evidence).toContain('800,000');
        expect(finding.evidence).toContain('2.0x');
    });

    it('says nothing when the work was even', () => {
        expect(
            distributedFindings({
                shards: [work('1', 1_001_760, true), work('2', 998_240)],
                totalReadRows: 2_000_000,
                skew: 1.004,
            })
        ).toEqual([]);
    });

    it('says nothing about a query that ran on one shard', () => {
        expect(
            distributedFindings({ shards: [work('1', 100, true)], totalReadRows: 100, skew: 1 })
        ).toEqual([]);
    });
});
