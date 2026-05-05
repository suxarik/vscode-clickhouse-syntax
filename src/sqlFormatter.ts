/**
 * SQL formatter for ClickHouse queries.
 */

export function formatSQL(text: string, keywordCase: string, indentSize: number): string {
    if (!text || !text.trim()) return text;

    const sp = ' '.repeat(indentSize);
    const holes: string[] = [];
    const protect = (s: string): string => {
        holes.push(s);
        return `\x01${holes.length - 1}\x01`;
    };

    let sql = text
        .replace(/\/\*[\s\S]*?\*\//g, protect)
        .replace(/--[^\n]*/g, protect)
        .replace(/'(?:[^'\\]|\\.)*'/g, protect)
        .replace(/`[^`]*`/g, protect)
        .replace(/"[^"]*"/g, protect);

    sql = sql.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();

    if (keywordCase !== 'preserve') {
        const toCase = (kw: string) => keywordCase === 'upper' ? kw.toUpperCase() : kw.toLowerCase();
        const KWS = [
            'LEFT ARRAY JOIN', 'ARRAY JOIN',
            'FULL OUTER JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
            'LEFT SEMI JOIN', 'RIGHT SEMI JOIN', 'LEFT ANTI JOIN', 'RIGHT ANTI JOIN',
            'ASOF JOIN', 'SEMI JOIN', 'ANTI JOIN',
            'GLOBAL NOT IN', 'GLOBAL IN',
            'WITH ROLLUP', 'WITH CUBE', 'WITH TOTALS', 'WITH FILL',
            'IS NOT NULL', 'IS NULL', 'NOT IN', 'NOT LIKE', 'NOT ILIKE', 'NOT BETWEEN', 'NOT EXISTS',
            'GROUP BY', 'ORDER BY', 'PARTITION BY', 'SAMPLE BY', 'PRIMARY KEY', 'LIMIT BY',
            'UNION ALL', 'INTERSECT', 'EXCEPT', 'UNION',
            'INSERT INTO', 'CREATE MATERIALIZED VIEW', 'CREATE TABLE', 'CREATE VIEW',
            'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'ON CLUSTER',
            'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'PREWHERE', 'HAVING', 'LIMIT', 'OFFSET', 'WITH',
            'JOIN', 'ON', 'USING', 'AS',
            'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE',
            'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF',
            'NULL', 'TRUE', 'FALSE', 'IS', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
            'FINAL', 'SAMPLE', 'SETTINGS', 'FORMAT', 'WINDOW', 'OVER',
            'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW',
            'INSERT', 'INTO', 'UPDATE', 'SET', 'DELETE', 'VALUES',
            'CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE', 'OPTIMIZE', 'ATTACH', 'DETACH',
            'TABLE', 'VIEW', 'DATABASE', 'DICTIONARY', 'FUNCTION', 'MATERIALIZED',
            'ENGINE', 'TTL', 'CODEC', 'INTERVAL', 'ALL', 'ANY', 'SOME', 'GLOBAL', 'ANTI', 'SEMI', 'ASOF',
            'SHOW', 'DESCRIBE', 'EXPLAIN', 'USE', 'KILL', 'SYSTEM',
        ];
        for (const kw of KWS) {
            const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
            sql = sql.replace(new RegExp(`\\b${esc}\\b`, 'gi'), toCase(kw));
        }
    }

    const BREAK_BEFORE_D0 = [
        'LEFT ARRAY JOIN', 'ARRAY JOIN',
        'FULL OUTER JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
        'LEFT SEMI JOIN', 'RIGHT SEMI JOIN', 'LEFT ANTI JOIN', 'RIGHT ANTI JOIN',
        'ASOF JOIN', 'SEMI JOIN', 'ANTI JOIN', 'JOIN',
        'UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT',
        'SELECT', 'FROM', 'PREWHERE', 'WHERE', 'HAVING', 'WINDOW',
        'GROUP BY', 'ORDER BY', 'LIMIT BY', 'LIMIT', 'OFFSET',
        'SETTINGS', 'FORMAT',
    ];

    const BODY_NEXT_LINE = new Set([
        'SELECT', 'WHERE', 'PREWHERE', 'HAVING', 'GROUP BY', 'ORDER BY', 'LIMIT BY',
    ]);

    type Ctx = 'none' | 'select_list' | 'condition' | 'list';

    const peekWord = (pos: number, kw: string): boolean => {
        if (pos > 0 && /\w/.test(sql[pos - 1])) return false;
        if (!sql.slice(pos).toUpperCase().startsWith(kw)) return false;
        const end = pos + kw.length;
        if (end < sql.length && /\w/.test(sql[end])) return false;
        return true;
    };

    const matchFirst = (pos: number, kws: string[]): string | null => {
        const sorted = [...kws].sort((a, b) => b.length - a.length);
        for (const kw of sorted) {
            if (peekWord(pos, kw.toUpperCase())) return kw;
        }
        return null;
    };

    let out = '';
    let depth = 0;
    let ctx: Ctx = 'none';
    let i = 0;
    const n = sql.length;

    while (i < n) {
        const ch = sql[i];

        if (ch === '(') {
            out += '(';
            depth++;
            i++;
            continue;
        }

        if (ch === ')') {
            out += ')';
            if (depth > 0) depth--;
            i++;
            continue;
        }

        if (ch === ';') {
            out = out.trimEnd() + ';\n';
            i++;
            ctx = 'none';
            depth = 0;
            while (i < n && sql[i] === ' ') i++;
            if (i < n) out += '\n';
            continue;
        }

        if (ch === ',') {
            if (depth === 0 && (ctx === 'select_list' || ctx === 'list')) {
                out = out.trimEnd() + ',\n' + sp;
                i++;
                while (i < n && sql[i] === ' ') i++;
                continue;
            }
            out += ',';
            i++;
            continue;
        }

        if (ch === ' ') {
            out += ' ';
            i++;
            continue;
        }

        if (depth === 0 && /[A-Za-z]/.test(ch)) {
            const kw = matchFirst(i, BREAK_BEFORE_D0);
            if (kw) {
                const kwUpper = kw.toUpperCase();
                const kwInSql = sql.slice(i, i + kw.length);

                if (kwUpper === 'SELECT') ctx = 'select_list';
                else if (['WHERE', 'PREWHERE', 'HAVING'].includes(kwUpper)) ctx = 'condition';
                else if (['GROUP BY', 'ORDER BY', 'LIMIT BY'].includes(kwUpper)) ctx = 'list';
                else ctx = 'none';

                if (out.trimEnd().length > 0) out = out.trimEnd() + '\n';
                out += kwInSql;
                i += kw.length;

                if (BODY_NEXT_LINE.has(kwUpper)) {
                    if (i < n && sql[i] === ' ') i++;
                    out += '\n' + sp;
                } else {
                    out += ' ';
                }
                continue;
            }

            if (peekWord(i, 'ON') && !peekWord(i, 'ON CLUSTER')) {
                ctx = 'condition';
                out = out.trimEnd() + '\n' + sp;
                out += sql.slice(i, i + 2);
                i += 2;
                if (i < n && sql[i] === ' ') i++;
                out += '\n' + sp + sp;
                continue;
            }

            if (ctx === 'condition') {
                if (peekWord(i, 'AND')) {
                    out = out.trimEnd() + '\n' + sp;
                    out += sql.slice(i, i + 3);
                    i += 3;
                    if (i < n && sql[i] === ' ') i++;
                    out += ' ';
                    continue;
                }
                if (peekWord(i, 'OR')) {
                    out = out.trimEnd() + '\n' + sp;
                    out += sql.slice(i, i + 2);
                    i += 2;
                    if (i < n && sql[i] === ' ') i++;
                    out += ' ';
                    continue;
                }
            }
        }

        out += ch;
        i++;
    }

    out = out.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return out.replace(/\x01(\d+)\x01/g, (_, idx) => holes[parseInt(idx)]);
}
