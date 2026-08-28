/**
 * The result grid.
 *
 * Plain DOM, no framework: it has to run in a webview panel and, later, in a
 * notebook renderer iframe, where a framework runtime would be dead weight.
 * Rows are windowed, so a hundred thousand of them cost the same as twenty.
 */
import {
    formatBytes,
    formatCount,
    formatDuration,
    formatExpanded,
    formatValue,
    isNumericType,
} from '../format';
import { filteredIndices, nextSort, sortedIndices, SortState, visibleWindow } from '../grid';
import { ColumnMeta, HostMessage, ResultStatistics, SerializationFormat } from '../protocol';
import { Transport } from './transport';

const ROW_HEIGHT = 22;
const MAX_CELL_CHARS = 200;

interface State {
    columns: ColumnMeta[];
    rows: unknown[][];
    order: number[];
    sort?: SortState;
    filter: string;
    statistics?: ResultStatistics;
    truncated: boolean;
    running: boolean;
    error?: string;
    profile: string;
    query: string;
}

export class GridView {
    private state: State = {
        columns: [],
        rows: [],
        order: [],
        filter: '',
        truncated: false,
        running: false,
        profile: '',
        query: '',
    };

    private readonly elements: {
        toolbar: HTMLElement;
        filter: HTMLInputElement;
        cancel: HTMLButtonElement;
        scroller: HTMLElement;
        spacer: HTMLElement;
        table: HTMLElement;
        head: HTMLElement;
        body: HTMLElement;
        footer: HTMLElement;
        message: HTMLElement;
    };

    constructor(
        private readonly root: HTMLElement,
        private readonly transport: Transport
    ) {
        this.root.className = 'ch-results';
        this.root.innerHTML = TEMPLATE;
        this.elements = {
            toolbar: this.must('.ch-toolbar'),
            filter: this.must('.ch-filter') as HTMLInputElement,
            cancel: this.must('.ch-cancel') as HTMLButtonElement,
            scroller: this.must('.ch-scroller'),
            spacer: this.must('.ch-spacer'),
            table: this.must('.ch-table'),
            head: this.must('.ch-head'),
            body: this.must('.ch-body'),
            footer: this.must('.ch-footer'),
            message: this.must('.ch-message'),
        };

        this.bindEvents();
        this.transport.onMessage(message => this.handle(message));
        this.transport.post({ type: 'ready' });
    }

    private must(selector: string): HTMLElement {
        const element = this.root.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Result view is missing ${selector}`);
        return element;
    }

    // ── Messages ─────────────────────────────────────────────────────────────

    private handle(message: HostMessage): void {
        switch (message.type) {
            case 'begin':
                this.state = {
                    columns: message.header.columns,
                    rows: [],
                    order: [],
                    filter: this.state.filter,
                    sort: undefined,
                    truncated: false,
                    running: true,
                    profile: message.header.profile,
                    query: message.header.query,
                };
                this.renderHead();
                this.renderAll();
                break;

            case 'rows':
                this.state.rows.push(...message.rows);
                this.reindex();
                this.renderAll();
                break;

            case 'end':
                this.state.running = false;
                this.state.statistics = message.statistics;
                this.state.truncated = message.truncated;
                this.renderAll();
                break;

            case 'error':
                this.state.running = false;
                this.state.error = message.code !== undefined
                    ? `${message.message} (code ${message.code})`
                    : message.message;
                this.renderAll();
                break;

            case 'cancelled':
                this.state.running = false;
                this.state.error = 'Query cancelled.';
                this.renderAll();
                break;
        }
    }

    // ── Events ───────────────────────────────────────────────────────────────

    private bindEvents(): void {
        this.elements.scroller.addEventListener('scroll', () => this.renderBody());

        this.elements.filter.addEventListener('input', () => {
            this.state.filter = this.elements.filter.value;
            this.reindex();
            this.renderAll();
        });

        this.elements.cancel.addEventListener('click', () => this.transport.post({ type: 'cancel' }));

        this.elements.toolbar.addEventListener('click', event => {
            const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
            if (!target) return;
            const format = target.dataset.format as SerializationFormat | undefined;
            if (target.dataset.action === 'copy' && format) {
                this.transport.post({ type: 'copy', format, scope: 'all' });
            } else if (target.dataset.action === 'export' && format) {
                this.transport.post({ type: 'export', format });
            }
        });

        this.elements.head.addEventListener('click', event => {
            const header = (event.target as HTMLElement).closest<HTMLElement>('[data-column]');
            if (!header) return;
            this.state.sort = nextSort(this.state.sort, Number(header.dataset.column));
            this.reindex();
            this.renderAll();
        });

        // A composite cell opens in full rather than being silently truncated.
        this.elements.body.addEventListener('click', event => {
            const cell = (event.target as HTMLElement).closest<HTMLElement>('.ch-cell.is-composite');
            if (!cell) return;
            const row = Number(cell.dataset.row);
            const column = Number(cell.dataset.col);
            this.showDetail(this.state.rows[row]?.[column], this.state.columns[column]);
        });
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    private reindex(): void {
        const filtered = filteredIndices(this.state.rows, this.state.columns, this.state.filter);
        this.state.order = this.state.sort
            ? sortedIndices(
                  filtered.map(index => this.state.rows[index]),
                  this.state.columns,
                  this.state.sort
              ).map(position => filtered[position])
            : filtered;
    }

    private renderAll(): void {
        this.renderHead();
        this.renderBody();
        this.renderFooter();
        this.elements.cancel.hidden = !this.state.running;
        this.elements.message.textContent = this.state.error ?? '';
        this.elements.message.hidden = !this.state.error;
    }

    private headSignature = '';

    private renderHead(): void {
        const signature = `${this.state.columns.map(c => `${c.name}:${c.type}`).join('|')}#${
            this.state.sort ? `${this.state.sort.column}:${this.state.sort.direction}` : '-'
        }`;
        if (signature === this.headSignature) return;
        this.headSignature = signature;

        this.elements.head.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'ch-row ch-header-row';

        const gutter = document.createElement('div');
        gutter.className = 'ch-cell ch-gutter';
        row.appendChild(gutter);

        this.state.columns.forEach((column, index) => {
            const cell = document.createElement('div');
            cell.className = 'ch-cell ch-header-cell';
            cell.dataset.column = String(index);
            if (isNumericType(column.type)) cell.classList.add('is-numeric');

            const arrow =
                this.state.sort?.column === index ? (this.state.sort.direction === 'asc' ? ' ▲' : ' ▼') : '';
            cell.textContent = `${column.name}${arrow}`;
            cell.title = `${column.name} — ${column.type}`;
            row.appendChild(cell);
        });

        this.elements.head.appendChild(row);
    }

    private renderBody(): void {
        const window_ = visibleWindow(
            this.state.order.length,
            ROW_HEIGHT,
            this.elements.scroller.scrollTop,
            this.elements.scroller.clientHeight
        );

        this.elements.spacer.style.height = `${window_.totalHeight}px`;
        this.elements.table.style.transform = `translateY(${window_.offsetTop}px)`;

        const fragment = document.createDocumentFragment();
        for (let position = window_.start; position < window_.end; position++) {
            const rowIndex = this.state.order[position];
            fragment.appendChild(this.renderRow(rowIndex, position));
        }
        this.elements.body.innerHTML = '';
        this.elements.body.appendChild(fragment);
    }

    private renderRow(rowIndex: number, position: number): HTMLElement {
        const row = document.createElement('div');
        row.className = 'ch-row';
        row.style.height = `${ROW_HEIGHT}px`;

        const gutter = document.createElement('div');
        gutter.className = 'ch-cell ch-gutter';
        gutter.textContent = String(position + 1);
        row.appendChild(gutter);

        const values = this.state.rows[rowIndex] ?? [];
        this.state.columns.forEach((column, columnIndex) => {
            const value = values[columnIndex];
            const cell = document.createElement('div');
            cell.className = 'ch-cell';
            cell.dataset.row = String(rowIndex);
            cell.dataset.col = String(columnIndex);

            if (value === null || value === undefined) {
                cell.classList.add('is-null');
                cell.textContent = 'NULL';
            } else {
                if (isNumericType(column.type)) cell.classList.add('is-numeric');
                if (typeof value === 'object') cell.classList.add('is-composite');
                const text = formatValue(value, column.type, { maxLength: MAX_CELL_CHARS });
                cell.textContent = text;
                cell.title = text;
            }
            row.appendChild(cell);
        });

        return row;
    }

    private renderFooter(): void {
        const stats = this.state.statistics;
        const shown = this.state.order.length;
        const total = this.state.rows.length;

        const parts: string[] = [];
        parts.push(this.state.running ? `${formatCount(total)} rows…` : `${formatCount(shown)} rows`);
        if (shown !== total) parts.push(`of ${formatCount(total)}`);
        if (this.state.truncated) parts.push('(truncated)');
        if (stats?.elapsedMs !== undefined) parts.push(formatDuration(stats.elapsedMs));
        if (stats?.readRows !== undefined) parts.push(`read ${formatCount(stats.readRows)} rows`);
        if (stats?.readBytes !== undefined) parts.push(formatBytes(stats.readBytes));
        if (this.state.profile) parts.push(`· ${this.state.profile}`);

        this.elements.footer.textContent = parts.join('  ');
    }

    private showDetail(value: unknown, column: ColumnMeta | undefined): void {
        const existing = this.root.querySelector('.ch-detail');
        if (existing) existing.remove();

        const detail = document.createElement('div');
        detail.className = 'ch-detail';

        const header = document.createElement('div');
        header.className = 'ch-detail-head';
        header.textContent = `${column?.name ?? ''} — ${column?.type ?? ''}`;

        const close = document.createElement('button');
        close.textContent = '✕';
        close.className = 'ch-detail-close';
        close.addEventListener('click', () => detail.remove());
        header.appendChild(close);

        const body = document.createElement('pre');
        body.className = 'ch-detail-body';
        body.textContent = formatExpanded(value, column?.type ?? '');

        detail.append(header, body);
        this.root.appendChild(detail);
    }
}

const TEMPLATE = `
<div class="ch-toolbar">
  <input class="ch-filter" type="search" placeholder="Filter rows…" spellcheck="false" />
  <span class="ch-spacer-flex"></span>
  <button class="ch-cancel" hidden>Cancel</button>
  <span class="ch-menu">Copy
    <button data-action="copy" data-format="tsv">TSV</button>
    <button data-action="copy" data-format="csv">CSV</button>
    <button data-action="copy" data-format="json">JSON</button>
    <button data-action="copy" data-format="markdown">MD</button>
  </span>
  <span class="ch-menu">Export
    <button data-action="export" data-format="csv">CSV</button>
    <button data-action="export" data-format="json">JSON</button>
  </span>
</div>
<div class="ch-message" hidden></div>
<div class="ch-head"></div>
<div class="ch-scroller">
  <div class="ch-spacer"></div>
  <div class="ch-table"><div class="ch-body"></div></div>
</div>
<div class="ch-footer"></div>
`;
