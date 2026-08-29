import { ClickHouseClient } from '../client/httpClient';
import { ResolvedConnection } from '../client/types';
jest.setTimeout(60000);
const CONN: ResolvedConnection = {
  name: 'r', url: 'http://localhost:18123', user: 'default',
  database: 'analytics', allowWrite: false, isProtected: false, settings: {},
};
test('sequential runs', async () => {
  const c = new ClickHouseClient(CONN);
  for (let i = 1; i <= 8; i++) {
    const t0 = Date.now();
    try {
      const r = await c.query('SELECT event_type, count() FROM analytics.events GROUP BY event_type', { readOnly: true, maxExecutionTime: 10 });
      console.log(`RUN ${i}: ok rows=${r.rows.length} in ${Date.now()-t0}ms`);
    } catch (e) {
      console.log(`RUN ${i}: FAILED in ${Date.now()-t0}ms -> ${(e as Error).message.slice(0,80)}`);
    }
  }
});
test('bad table', async () => {
  const c = new ClickHouseClient(CONN);
  try { const r = await c.query('select first, last from t where type = 1', { readOnly: true }); console.log('BADTABLE: rows=', r.rows.length, 'cols=', r.columns.length); }
  catch (e) { console.log('BADTABLE error:', (e as Error).message.slice(0,90)); }
});
