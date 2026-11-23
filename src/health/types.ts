/**
 * What a MergeTree server is doing to its own data.
 *
 * Everything here is one node's view, read from `system` tables. The
 * questions it answers are the ones asked during an incident about storage:
 * are there too many parts, is a merge or a mutation stuck, is a disk about to
 * fill, has something been detached. None of it needs anything but SELECT.
 */

/** Active parts of one table in one partition, which is the unit ClickHouse limits. */
export interface PartitionParts {
    database: string;
    table: string;
    partition: string;
    parts: number;
    rows: number;
    bytes: number;
}

/** A merge running right now, from `system.merges`. */
export interface RunningMerge {
    database: string;
    table: string;
    elapsedSeconds: number;
    /** 0..1 */
    progress: number;
    numParts: number;
    bytes: number;
    isMutation: boolean;
}

/** A mutation that has not finished, from `system.mutations`. */
export interface PendingMutation {
    database: string;
    table: string;
    id: string;
    command: string;
    ageSeconds: number;
    partsToDo: number;
    /** Empty while it is progressing; ClickHouse fills it in when a part fails. */
    failReason: string;
}

export interface DiskUsage {
    name: string;
    freeBytes: number;
    totalBytes: number;
}

/** Parts that are on disk but not part of the table, from `system.detached_parts`. */
export interface DetachedGroup {
    database: string;
    table: string;
    /** Why it was detached. Empty means someone ran DETACH on purpose. */
    reason: string;
    parts: number;
}

/** The limits that decide when inserts slow down and then fail. */
export interface PartLimits {
    /** `parts_to_delay_insert`: past this in one partition, inserts are slowed. */
    delayAt: number;
    /** `parts_to_throw_insert`: past this, inserts fail with TOO_MANY_PARTS. */
    throwAt: number;
}

export interface HealthView {
    /** Set when the view was narrowed to one table. */
    scope?: { database: string; table: string };
    partitions: PartitionParts[];
    merges: RunningMerge[];
    mutations: PendingMutation[];
    disks: DiskUsage[];
    detached: DetachedGroup[];
    limits: PartLimits;
    /** Whether `limits` came from the server or are ClickHouse's documented defaults. */
    limitsFromServer: boolean;
    /** What could not be read, by name, so a gap is never mistaken for health. */
    unavailable: string[];
}
