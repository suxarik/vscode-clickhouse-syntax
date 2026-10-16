/**
 * Tests for reading what each shard did.
 */
import { shardWorkFrom } from '../cluster/distributed';
import { QueryResult } from '../client/types';

const COLUMNS = ['shard', 'host', 'is_initiator', 'query_duration_ms', 'read_rows', 'read_bytes', 'memory_usage'];

function answer(rows: unknown[][]): QueryResult {
    return {
        queryId: 'q',
        columns: COLUMNS.map(name => ({ name, type: 'String' })),
        rows,
        truncated: false,
        elapsedMs: 1,
    };
}

describe('shardWorkFrom', () => {
    it('takes the remote shards off the initiator, which counts the whole query', () => {
        // The initiator reports 1.2M for the query; the remote shard read 400k
        // of them, so the initiator's own shard read 800k.
        const profile = shardWorkFrom(
            answer([
                ['1', 'ch-01', 1, 815, 1_200_000, 12_000, 1_900_000],
                ['2', 'ch-03', 0, 130, 400_000, 4_000, 400_000],
            ])
        );

        expect(profile?.shards.find(s => s.shard === '1')?.readRows).toBe(800_000);
        expect(profile?.shards.find(s => s.shard === '2')?.readRows).toBe(400_000);
        expect(profile?.totalReadRows).toBe(1_200_000);
    });

    it('measures how unevenly the work fell', () => {
        const profile = shardWorkFrom(
            answer([
                ['1', 'ch-01', 1, 815, 1_200_000, 12_000, 1],
                ['2', 'ch-03', 0, 130, 400_000, 4_000, 1],
            ])
        );
        expect(profile?.skew).toBeCloseTo(2);
    });

    it('calls an even split even', () => {
        const profile = shardWorkFrom(
            answer([
                ['1', 'ch-01', 1, 60, 2_000_000, 20_000, 1],
                ['2', 'ch-03', 0, 42, 1_000_000, 10_000, 1],
            ])
        );
        expect(profile?.skew).toBeCloseTo(1);
    });

    it('says nothing for a query that ran on one node', () => {
        expect(shardWorkFrom(answer([['1', 'ch-01', 1, 60, 2_000_000, 20_000, 1]]))).toBeUndefined();
    });

    it('says nothing when the log had not been written', () => {
        expect(shardWorkFrom(answer([]))).toBeUndefined();
    });

    it('never reports a shard reading a negative number of rows', () => {
        // The remote rows can exceed the initiator's count when a log is
        // written mid-flight; the arithmetic must not produce nonsense.
        const profile = shardWorkFrom(
            answer([
                ['1', 'ch-01', 1, 60, 100, 10, 1],
                ['2', 'ch-03', 0, 42, 900, 90, 1],
            ])
        );
        expect(profile?.shards.every(shard => shard.readRows >= 0)).toBe(true);
    });

    it('keeps the shards in order, so two runs read the same way', () => {
        const profile = shardWorkFrom(
            answer([
                ['3', 'ch-05', 0, 10, 100, 1, 1],
                ['1', 'ch-01', 1, 60, 400, 4, 1],
                ['2', 'ch-03', 0, 20, 200, 2, 1],
            ])
        );
        expect(profile?.shards.map(shard => shard.shard)).toEqual(['1', '2', '3']);
    });
});
