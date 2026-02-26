import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// ClickHouse-exclusive patterns — each one is unique to ClickHouse and cannot
// reasonably appear in MySQL, PostgreSQL, MSSQL, or SQLite SQL files.
// ---------------------------------------------------------------------------
const CH_DETECTION_PATTERNS: RegExp[] = [
    // Table engines
    /ENGINE\s*=\s*(MergeTree|ReplicatedMergeTree|ReplacingMergeTree|SummingMergeTree|AggregatingMergeTree|CollapsingMergeTree|VersionedCollapsingMergeTree|GraphiteMergeTree|Distributed|Buffer|TinyLog|StripeLog)\s*[\(\s;]/i,
    // ClickHouse-exclusive clauses
    /\bPREWHERE\b/i,
    /\bLIMIT\s+\d+\s+BY\b/i,
    /\bWITH\s+TOTALS\b/i,
    /\bWITH\s+ROLLUP\b/i,
    /\bWITH\s+CUBE\b/i,
    /\bARRAY\s+JOIN\b/i,
    /\bGLOBAL\s+(NOT\s+)?IN\b/i,
    /\bASOf\s+JOIN\b/i,
    // ClickHouse FORMAT clause (very distinctive)
    /\bFORMAT\s+(TabSeparated|JSONEachRow|JSONCompact|Parquet|Arrow|ORC|Avro|RowBinary|Native|PrettyCompact|Pretty|CSV|CSVWithNames|LineAsString|RawBLOB)\b/i,
    // ClickHouse-exclusive data types
    /\b(UInt8|UInt16|UInt32|UInt64|UInt128|UInt256|Int128|Int256|Float32|Float64)\b/,
    /\bDateTime64\s*\(/i,
    /\bLowCardinality\s*\(/i,
    /\bFixedString\s*\(/i,
    /\bAggregateFunction\s*\(/i,
    /\bSimpleAggregateFunction\s*\(/i,
    // ClickHouse-exclusive functions
    /\b(groupArray|groupUniqArray|groupArrayInsertAt|groupBitmap)\s*\(/i,
    /\barrayJoin\s*\(/i,
    /\b(windowFunnel|sequenceMatch|sequenceCount|retention)\s*\(/i,
    /\b(dictGet|dictGetOrDefault|dictHas)\s*\(/i,
    /\b(uniqExact|uniqHLL12|uniqCombined|uniqTheta)\s*\(/i,
    /\b(argMin|argMax)\s*\(/i,
    /\b(topK|topKWeighted)\s*\(/i,
    /\b(quantileTDigest|quantileTiming|quantileDeterministic)\s*\(/i,
    /\b(toYYYYMM|toYYYYMMDD|toStartOfInterval|toRelativeHourNum)\s*\(/i,
    /\b(parseDateTimeBestEffort|formatReadableSize|formatReadableQuantity)\s*\(/i,
    /\b(accurateCast|accurateCastOrNull|bitCast|reinterpretAs)\s*\(/i,
    /\b(generateUUIDv4|generateUUIDv7|UUIDStringToNum|UUIDNumToString)\s*\(/i,
    // ClickHouse SETTINGS at query level
    /\)\s*SETTINGS\s+\w+\s*=/i,
    // ClickHouse TTL / CODEC on table definitions
    /\bTTL\s+\w+.*\+\s*INTERVAL\b/i,
    /\bCODEC\s*\(\s*(Delta|Gorilla|ZSTD|LZ4|LZ4HC|DoubleDelta|FPC|T64)\b/i,
    // SAMPLE BY clause (unique to MergeTree)
    /\bSAMPLE\s+BY\b/i,
    // ClickHouse system tables
    /\bFROM\s+system\.(tables|columns|functions|databases|merges|mutations|parts|replicas|query_log|processes)\b/i,
    // ON CLUSTER
    /\bON\s+CLUSTER\s+\w+/i,
];

/**
 * Analyse a chunk of SQL text and return true if it contains ClickHouse-
 * exclusive syntax. Only the first 8 KB are scanned for performance.
 */
function isClickHouseSQL(text: string): boolean {
    const sample = text.length > 8192 ? text.slice(0, 8192) : text;
    return CH_DETECTION_PATTERNS.some(re => re.test(sample));
}

/**
 * If document is a SQL file (not already set to clickhouse), check its
 * content and switch the language mode when ClickHouse patterns are found.
 */
async function detectAndApplyLanguage(document: vscode.TextDocument): Promise<void> {
    if (document.languageId === 'clickhouse') {
        return; // already set
    }
    // Only attempt detection for SQL files and plain text
    if (!['sql', 'plaintext'].includes(document.languageId)) {
        return;
    }
    if (document.uri.scheme !== 'file') {
        return;
    }

    if (isClickHouseSQL(document.getText())) {
        try {
            await vscode.languages.setTextDocumentLanguage(document, 'clickhouse');
        } catch {
            // Language switch can fail if the doc was closed; silently ignore
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('ClickHouse SQL extension is now active');

    // -----------------------------------------------------------------------
    // Auto-detect ClickHouse SQL in .sql files on open and save
    // -----------------------------------------------------------------------

    // Check every SQL document that is already open when the extension loads
    vscode.workspace.textDocuments.forEach(doc => detectAndApplyLanguage(doc));

    // Check new documents as they are opened
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => detectAndApplyLanguage(doc))
    );

    // Re-check on save (user may have just added ClickHouse-specific syntax)
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => detectAndApplyLanguage(doc))
    );

    // Register a manual command so the user can trigger detection on demand
    context.subscriptions.push(
        vscode.commands.registerCommand('clickhouse.detectLanguage', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            const doc = editor.document;
            if (isClickHouseSQL(doc.getText())) {
                await vscode.languages.setTextDocumentLanguage(doc, 'clickhouse');
                vscode.window.showInformationMessage('Language set to ClickHouse SQL');
            } else {
                vscode.window.showWarningMessage('No ClickHouse-specific syntax detected in this file.');
            }
        })
    );

    // Register formatter for clickhouse language
    const formatterProvider = vscode.languages.registerDocumentFormattingEditProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideDocumentFormattingEdits(
                document: vscode.TextDocument
            ): vscode.TextEdit[] {
                const config = vscode.workspace.getConfiguration('clickhouse');
                const enabled = config.get<boolean>('format.enabled', true);

                if (!enabled) {
                    return [];
                }

                const keywordCase = config.get<string>('format.keywordCase', 'upper');
                const indentSize = config.get<number>('format.indentSize', 4);

                const text = document.getText();
                const formatted = formatSQL(text, keywordCase, indentSize);

                if (formatted === text) {
                    return [];
                }

                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(text.length)
                );

                return [vscode.TextEdit.replace(fullRange, formatted)];
            }
        }
    );

    // Register range formatter
    const rangeFormatterProvider = vscode.languages.registerDocumentRangeFormattingEditProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideDocumentRangeFormattingEdits(
                document: vscode.TextDocument,
                range: vscode.Range
            ): vscode.TextEdit[] {
                const config = vscode.workspace.getConfiguration('clickhouse');
                const enabled = config.get<boolean>('format.enabled', true);

                if (!enabled) {
                    return [];
                }

                const keywordCase = config.get<string>('format.keywordCase', 'upper');
                const indentSize = config.get<number>('format.indentSize', 4);

                const text = document.getText(range);
                const formatted = formatSQL(text, keywordCase, indentSize);

                if (formatted === text) {
                    return [];
                }

                return [vscode.TextEdit.replace(range, formatted)];
            }
        }
    );

    // Register hover provider for ClickHouse functions
    const hoverProvider = vscode.languages.registerHoverProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideHover(
                document: vscode.TextDocument,
                position: vscode.Position
            ): vscode.Hover | undefined {
                const range = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
                if (!range) {
                    return undefined;
                }
                const word = document.getText(range).toLowerCase();
                const info = CH_FUNCTION_DOCS[word];
                if (info) {
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown(`**${info.name}**\n\n`);
                    md.appendMarkdown(`${info.description}\n\n`);
                    if (info.signature) {
                        md.appendCodeblock(info.signature, 'clickhouse');
                    }
                    if (info.example) {
                        md.appendMarkdown(`\n**Example:**\n`);
                        md.appendCodeblock(info.example, 'clickhouse');
                    }
                    return new vscode.Hover(md, range);
                }
                return undefined;
            }
        }
    );

    // Register completion provider for ClickHouse keywords and functions
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideCompletionItems(
                document: vscode.TextDocument,
                position: vscode.Position
            ): vscode.CompletionItem[] {
                const items: vscode.CompletionItem[] = [];

                // Add keyword completions
                for (const keyword of CH_KEYWORDS) {
                    const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
                    item.detail = 'ClickHouse keyword';
                    items.push(item);
                }

                // Add function completions
                for (const [name, info] of Object.entries(CH_FUNCTION_DOCS)) {
                    const item = new vscode.CompletionItem(info.name, vscode.CompletionItemKind.Function);
                    item.detail = 'ClickHouse function';
                    item.documentation = new vscode.MarkdownString(info.description);
                    if (info.insertText) {
                        item.insertText = new vscode.SnippetString(info.insertText);
                    }
                    items.push(item);
                }

                // Add data type completions
                for (const type of CH_DATA_TYPES) {
                    const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.TypeParameter);
                    item.detail = 'ClickHouse data type';
                    items.push(item);
                }

                return items;
            }
        },
        '.', '(', ' '
    );

    context.subscriptions.push(
        formatterProvider,
        rangeFormatterProvider,
        hoverProvider,
        completionProvider
    );
}

/**
 * Format SQL text with proper keyword casing and indentation
 */
function formatSQL(text: string, keywordCase: string, indentSize: number): string {
    const indent = ' '.repeat(indentSize);
    const lines = text.split('\n');
    const formattedLines: string[] = [];

    const MAIN_KEYWORDS = [
        'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
        'FULL JOIN', 'CROSS JOIN', 'ARRAY JOIN', 'LEFT ARRAY JOIN',
        'PREWHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'LIMIT BY',
        'OFFSET', 'UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT',
        'WITH', 'SETTINGS', 'FORMAT', 'SAMPLE', 'WINDOW'
    ];

    const CLAUSE_KEYWORDS = new Set(MAIN_KEYWORDS.map(k => k.toUpperCase()));

    for (let line of lines) {
        const trimmed = line.trim();

        if (trimmed === '' || trimmed.startsWith('--') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            formattedLines.push(line);
            continue;
        }

        let processed = trimmed;

        // Apply keyword casing
        if (keywordCase !== 'preserve') {
            const keywords = [
                'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS',
                'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL',
                'ON', 'USING', 'AS', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
                'UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'WITH', 'RECURSIVE',
                'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
                'CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE', 'OPTIMIZE',
                'TABLE', 'VIEW', 'DATABASE', 'DICTIONARY', 'FUNCTION',
                'ENGINE', 'PARTITION', 'ORDER', 'PRIMARY', 'KEY', 'SAMPLE', 'BY',
                'SETTINGS', 'FORMAT', 'PREWHERE', 'FINAL', 'ARRAY',
                'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF',
                'BETWEEN', 'LIKE', 'ILIKE', 'IS', 'NULL', 'TRUE', 'FALSE',
                'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
                'OVER', 'WINDOW', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW',
                'TTL', 'CODEC', 'MOD', 'DIV', 'GLOBAL', 'ANTI', 'SEMI', 'ASOF',
                'WITH ROLLUP', 'WITH CUBE', 'WITH TOTALS',
                'SHOW', 'DESCRIBE', 'EXPLAIN', 'USE', 'ATTACH', 'DETACH',
                'SYSTEM', 'KILL', 'RELOAD', 'FLUSH', 'SYNC', 'ASYNC'
            ];

            for (const kw of keywords) {
                const escaped = kw.replace(/\s+/g, '\\s+').replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
                const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
                if (keywordCase === 'upper') {
                    processed = processed.replace(regex, kw.toUpperCase());
                } else if (keywordCase === 'lower') {
                    processed = processed.replace(regex, kw.toLowerCase());
                }
            }
        }

        // Detect if line starts with a main SQL clause keyword
        const upperProcessed = processed.toUpperCase().trimStart();
        let isClause = false;
        for (const kw of CLAUSE_KEYWORDS) {
            if (upperProcessed.startsWith(kw + ' ') || upperProcessed === kw || upperProcessed.startsWith(kw + '\t')) {
                isClause = true;
                break;
            }
        }

        formattedLines.push(processed);
    }

    return formattedLines.join('\n');
}

// ClickHouse keywords list for completion
const CH_KEYWORDS = [
    'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING',
    'LIMIT', 'LIMIT BY', 'OFFSET', 'UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT',
    'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
    'ARRAY JOIN', 'LEFT ARRAY JOIN', 'ASOF JOIN', 'GLOBAL IN', 'GLOBAL NOT IN',
    'PREWHERE', 'SAMPLE', 'FINAL', 'FORMAT', 'SETTINGS', 'WITH TOTALS',
    'WITH ROLLUP', 'WITH CUBE', 'WITH', 'OVER', 'PARTITION BY', 'WINDOW',
    'INSERT INTO', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE',
    'CREATE VIEW', 'CREATE MATERIALIZED VIEW', 'CREATE DICTIONARY',
    'ENGINE', 'PARTITION BY', 'ORDER BY', 'PRIMARY KEY', 'SAMPLE BY',
    'TTL', 'CODEC', 'DEDUPLICATE', 'OPTIMIZE',
    'SHOW TABLES', 'SHOW DATABASES', 'DESCRIBE TABLE', 'EXPLAIN',
    'SYSTEM RELOAD DICTIONARIES', 'SYSTEM FLUSH LOGS',
    'MergeTree', 'ReplicatedMergeTree', 'ReplacingMergeTree',
    'SummingMergeTree', 'AggregatingMergeTree', 'CollapsingMergeTree',
    'VersionedCollapsingMergeTree', 'Distributed', 'Buffer',
    'UInt8', 'UInt16', 'UInt32', 'UInt64', 'UInt128', 'UInt256',
    'Int8', 'Int16', 'Int32', 'Int64', 'Int128', 'Int256',
    'Float32', 'Float64', 'Decimal', 'String', 'FixedString',
    'Date', 'Date32', 'DateTime', 'DateTime64',
    'Array', 'Tuple', 'Map', 'Nested', 'Nullable', 'LowCardinality',
    'UUID', 'IPv4', 'IPv6', 'Bool', 'Enum8', 'Enum16'
];

// ClickHouse data types for completion
const CH_DATA_TYPES = [
    'UInt8', 'UInt16', 'UInt32', 'UInt64', 'UInt128', 'UInt256',
    'Int8', 'Int16', 'Int32', 'Int64', 'Int128', 'Int256',
    'Float32', 'Float64', 'BFloat16',
    'Decimal', 'Decimal32', 'Decimal64', 'Decimal128', 'Decimal256',
    'String', 'FixedString', 'UUID', 'IPv4', 'IPv6',
    'Date', 'Date32', 'DateTime', 'DateTime32', 'DateTime64',
    'Array', 'Tuple', 'Map', 'Nested', 'Set',
    'Nullable', 'LowCardinality',
    'AggregateFunction', 'SimpleAggregateFunction',
    'Enum8', 'Enum16', 'Bool', 'Nothing',
    'Point', 'Ring', 'Polygon', 'MultiPolygon'
];

// ClickHouse function documentation for hover tooltips
const CH_FUNCTION_DOCS: Record<string, {
    name: string;
    description: string;
    signature?: string;
    example?: string;
    insertText?: string;
}> = {
    'grouparray': {
        name: 'groupArray',
        description: 'Creates an array of argument values. Values can be added to the array in any (indeterminate) order.\nSupports optional `max_size` parameter to limit result size.',
        signature: 'groupArray([max_size])(x)',
        example: 'SELECT groupArray(3)(number) FROM numbers(10)',
        insertText: 'groupArray(${1:max_size})(${2:column})'
    },
    'groupuniqarray': {
        name: 'groupUniqArray',
        description: 'Creates an array of unique argument values.',
        signature: 'groupUniqArray([max_size])(x)',
        example: 'SELECT groupUniqArray(status) FROM events',
        insertText: 'groupUniqArray(${1:column})'
    },
    'arrayjoin': {
        name: 'arrayJoin',
        description: 'Takes an array and returns a table with a row for each array element. This is a special function that can be used in SELECT, equivalent to ARRAY JOIN clause.',
        signature: 'arrayJoin(arr)',
        example: "SELECT arrayJoin([1, 2, 3]) AS element",
        insertText: 'arrayJoin(${1:array})'
    },
    'quantile': {
        name: 'quantile',
        description: 'Computes an approximate quantile of a numeric data sequence.',
        signature: 'quantile(level)(x)',
        example: 'SELECT quantile(0.95)(response_time) FROM requests',
        insertText: 'quantile(${1:0.95})(${2:column})'
    },
    'topk': {
        name: 'topK',
        description: 'Returns an array of the approximately most frequent values in the specified column.',
        signature: 'topK(N)(column)',
        example: 'SELECT topK(5)(user_id) FROM events',
        insertText: 'topK(${1:5})(${2:column})'
    },
    'uniq': {
        name: 'uniq',
        description: 'Calculates the approximate number of different argument values.',
        signature: 'uniq(x[, ...])',
        example: 'SELECT uniq(user_id) FROM events',
        insertText: 'uniq(${1:column})'
    },
    'uniqexact': {
        name: 'uniqExact',
        description: 'Calculates the exact number of different argument values.',
        signature: 'uniqExact(x[, ...])',
        example: 'SELECT uniqExact(user_id) FROM events',
        insertText: 'uniqExact(${1:column})'
    },
    'argmin': {
        name: 'argMin',
        description: 'Calculates the `arg` value for a minimum `val` value.',
        signature: 'argMin(arg, val)',
        example: 'SELECT argMin(url, event_time) FROM events GROUP BY session_id',
        insertText: 'argMin(${1:arg}, ${2:val})'
    },
    'argmax': {
        name: 'argMax',
        description: 'Calculates the `arg` value for a maximum `val` value.',
        signature: 'argMax(arg, val)',
        example: 'SELECT argMax(url, event_time) FROM events GROUP BY session_id',
        insertText: 'argMax(${1:arg}, ${2:val})'
    },
    'windowfunnel': {
        name: 'windowFunnel',
        description: 'Searches for event chains in a sliding time window and counts the maximum number of events that occurred from the chain.',
        signature: 'windowFunnel(window, [mode, [mode, ...]])(timestamp, cond1, cond2, ..., condN)',
        example: "SELECT windowFunnel(86400)(event_time, event = 'view', event = 'cart', event = 'purchase') FROM user_events GROUP BY user_id",
        insertText: "windowFunnel(${1:86400})(${2:event_time}, ${3:cond1}, ${4:cond2})"
    },
    'retention': {
        name: 'retention',
        description: 'Takes a set of conditions and returns an Array of 1s and 0s indicating if each condition was met for a given group.',
        signature: 'retention(cond1, cond2, ..., cond32)',
        example: "SELECT sum(r[1]) AS r1, sum(r[2]) AS r2 FROM (SELECT retention(sign_up_date = today(), action_date = today() + 1) AS r FROM user_actions GROUP BY user_id)",
        insertText: 'retention(${1:cond1}, ${2:cond2})'
    },
    'dictget': {
        name: 'dictGet',
        description: 'Retrieves a value from a dictionary.',
        signature: "dictGet('dict_name', 'attr_name', id_expr)",
        example: "SELECT dictGet('default.products', 'name', product_id) FROM orders",
        insertText: "dictGet('${1:database}.${2:dict_name}', '${3:attribute}', ${4:key})"
    },
    'dictgetordefault': {
        name: 'dictGetOrDefault',
        description: 'Retrieves a value from a dictionary, returning default if not found.',
        signature: "dictGetOrDefault('dict_name', 'attr_name', id_expr, default_value)",
        example: "SELECT dictGetOrDefault('default.products', 'name', product_id, 'Unknown') FROM orders",
        insertText: "dictGetOrDefault('${1:database}.${2:dict_name}', '${3:attribute}', ${4:key}, ${5:default})"
    },
    'arraymap': {
        name: 'arrayMap',
        description: 'Returns an array obtained from the original application of the `func` function to each element in the `arr` array.',
        signature: 'arrayMap(func, arr1, ...)',
        example: 'SELECT arrayMap(x -> x * 2, [1, 2, 3])',
        insertText: 'arrayMap(${1:x} -> ${2:expression}, ${3:array})'
    },
    'arrayfilter': {
        name: 'arrayFilter',
        description: 'Returns an array containing only the elements in `arr1` for which `func` returns something other than 0.',
        signature: 'arrayFilter(func, arr1, ...)',
        example: "SELECT arrayFilter(x -> x > 0, [-1, 0, 1, 2])",
        insertText: 'arrayFilter(${1:x} -> ${2:condition}, ${3:array})'
    },
    'toyyyymm': {
        name: 'toYYYYMM',
        description: 'Converts a date or date with time to a UInt32 number containing the year and month number.',
        signature: 'toYYYYMM(date[, timezone])',
        example: "SELECT toYYYYMM(today())",
        insertText: 'toYYYYMM(${1:date})'
    },
    'formatreadablesize': {
        name: 'formatReadableSize',
        description: 'Accepts the size (number of bytes). Returns a rounded size with a suffix (KiB, MiB, etc.) as a string.',
        signature: 'formatReadableSize(x)',
        example: 'SELECT formatReadableSize(1073741824)',
        insertText: 'formatReadableSize(${1:bytes})'
    },
    'generateuuidv4': {
        name: 'generateUUIDv4',
        description: 'Generates a UUID version 4.',
        signature: 'generateUUIDv4([expr])',
        example: 'SELECT generateUUIDv4()',
        insertText: 'generateUUIDv4()'
    },
    'multiif': {
        name: 'multiIf',
        description: 'Allows writing the CASE operator more compactly in the query.',
        signature: 'multiIf(cond_1, then_1, cond_2, then_2, ..., else)',
        example: "SELECT multiIf(score >= 90, 'A', score >= 80, 'B', score >= 70, 'C', 'F') FROM grades",
        insertText: 'multiIf(${1:cond1}, ${2:result1}, ${3:cond2}, ${4:result2}, ${5:else_result})'
    },
    'accuratecast': {
        name: 'accurateCast',
        description: 'Converts x to the type data_type. Unlike cast, throws an error if x value is not representable by the type.',
        signature: 'accurateCast(x, T)',
        example: "SELECT accurateCast(1234, 'UInt8')",
        insertText: "accurateCast(${1:value}, '${2:type}')"
    },
    'now': {
        name: 'now',
        description: 'Returns the current date and time at the moment of query analysis.',
        signature: 'now([timezone])',
        example: 'SELECT now()',
        insertText: 'now()'
    },
    'today': {
        name: 'today',
        description: 'Accepts zero arguments and returns the current date at one of the moments of query analysis.',
        signature: 'today()',
        example: 'SELECT today()',
        insertText: 'today()'
    },
    'toyyyymmdd': {
        name: 'toYYYYMMDD',
        description: 'Converts a date or date with time to a UInt32 number containing the year and month and day number (YYYYMMDD).',
        signature: 'toYYYYMMDD(date[, timezone])',
        example: 'SELECT toYYYYMMDD(today())',
        insertText: 'toYYYYMMDD(${1:date})'
    }
};

export function deactivate() {
    console.log('ClickHouse SQL extension deactivated');
}
