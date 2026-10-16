/**
 * What a cluster looks like from the one node we are connected to.
 *
 * An extension reaches exactly one server. Every other node is visible only
 * through it, which decides what can be known: the configured topology comes
 * from `system.clusters`, and anything about a node's state has to be fetched
 * through `clusterAllReplicas`, where a node that does not answer is simply
 * absent rather than reported as down.
 */

/** One configured host, from `system.clusters`. */
export interface ClusterHost {
    cluster: string;
    shard: number;
    replica: number;
    host: string;
    port: number;
    isLocal: boolean;
    /** Failed connections this node has seen. Zero until one is attempted. */
    errors: number;
    slowdowns: number;
    estimatedRecoverySeconds: number;
}

/** One replicated table on one node, from `system.replicas`. */
export interface ReplicaHealth {
    /** The `replica` macro, which is how a row is matched to a configured host. */
    host: string;
    database: string;
    table: string;
    isReadonly: boolean;
    readonlySeconds: number;
    sessionExpired: boolean;
    absoluteDelaySeconds: number;
    queueSize: number;
    totalReplicas: number;
    activeReplicas: number;
    lostParts: number;
}

/** How much of a table one node is holding, from `system.parts`. */
export interface DataPlacement {
    /** The `shard` macro, so replicas of one shard can be compared. */
    shard: string;
    /** The `replica` macro. */
    host: string;
    database: string;
    table: string;
    rows: number;
    bytes: number;
    parts: number;
}

export interface ClusterView {
    cluster: string;
    hosts: ClusterHost[];
    health: ReplicaHealth[];
    /**
     * Configured hosts that did not answer.
     *
     * `system.clusters.errors_count` stays at zero until this node has actually
     * tried to reach another and failed, so a stopped replica is invisible
     * there. Absence from the fan-out is the signal that works.
     */
    unreachable: ClusterHost[];
    /**
     * Where the rows actually are.
     *
     * A sharding key is a promise about distribution that nothing checks. Three
     * distinct values across two shards cannot spread, and the cost of that is
     * a cluster whose throughput is capped by its busiest node — which is
     * invisible from any single node, since each looks perfectly healthy.
     */
    placement: DataPlacement[];
}
