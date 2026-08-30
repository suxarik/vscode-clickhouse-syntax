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
import {
    columnSamples,
    columnWidths,
    filteredIndices,
    MAX_COLUMN_CHARS,
    nextSort,
    sortedIndices,
    SortState,
    visibleWindow,
} from '../grid';
import { ColumnMeta, HostMessage, ResultStatistics, SerializationFormat } from '../protocol';
import { chartCaption, chartPoints, planChart, renderChart } from './chart';
import { Transport } from './transport';

const ROW_HEIGHT = 22;
const MAX_CELL_CHARS = 200;

/**
 * Horizontal padding and border of a cell, in pixels.
 *
 * `box-sizing: border-box` means these come out of the content box, so a column
 * sized purely by its character count is this much too narrow for what it holds
 * - which is why every column used to truncate a couple of characters early.
 */
const CELL_CHROME_PX = 8 + 8 + 1;

/** Narrowest a column may be dragged, in pixels. */
const MIN_COLUMN_PX = 40;

/** Used when the font cannot be measured, as in a test environment. */
const FALLBACK_CHAR_PX = 7.2;

interface State {
    columns: ColumnMeta[];
    /**
     * Shared width per column, in pixels.
     *
     * Pixels rather than characters because the padding and border are in
     * pixels too, and because a drag is a pixel measurement.
     */
    widths: number[];
    /** Columns the reader has sized by hand; never re-measured. */
    pinnedWidths: Set<number>;
    /** Widths are measured once, so columns do not jump as rows stream in. */
    widthsMeasured: boolean;
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
    /** Whether the chart is showing instead of the rows. */
    charting: boolean;
}

export class GridView {
    private state: State = {
        columns: [],
        widths: [],
        pinnedWidths: new Set(),
        widthsMeasured: false,
        rows: [],
        order: [],
        filter: '',
        truncated: false,
        running: false,
        profile: '',
        query: '',
        charting: false,
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
        chartButton: HTMLButtonElement;
        chart: HTMLElement;
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
            chartButton: this.must('.ch-chart-toggle') as HTMLButtonElement,
            chart: this.must('.ch-chart'),
        };

        this.bindEvents();
        this.transport.onMessage(message => this.handle(message));
        this.transport.post({ type: 'ready' });
    }

    /** Reused for every measurement, so the DOM is touched once per render. */
    private probe: HTMLElement | undefined;

    /**
     * How wide a string renders, in the grid's own font.
     *
     * Measured rather than computed from a character count: counting characters
     * is only right for a monospace font at an assumed size, and is wrong for
     * the header regardless, because the header is laid out bold.
     *
     * Returns 0 where nothing can be measured - a hidden host, or a test
     * environment with no layout - and the caller falls back to counting.
     */
    private textWidth(text: string, bold: boolean): number {
        if (!this.probe) {
            this.probe = document.createElement('span');
            this.probe.className = 'ch-probe';
            this.root.appendChild(this.probe);
        }
        this.probe.style.fontWeight = bold ? '600' : 'normal';
        this.probe.textContent = text;
        return this.probe.getBoundingClientRect().width;
    }

    /** Pixels each column needs for the text it holds, chrome included. */
    private widthsFor(rows: unknown[][], sampleSize?: number): number[] {
        const samples = columnSamples(this.state.columns, rows, sampleSize);
        const counted = columnWidths(this.state.columns, rows, sampleSize);
        // The widest a column may be measured to. Taken from the font in use
        // rather than assumed, so it means the same on any font.
        const cap = this.textWidth('M'.repeat(MAX_COLUMN_CHARS), false) || MAX_COLUMN_CHARS * FALLBACK_CHAR_PX;

        return samples.map((sample, index) => {
            // The header alone. The sort arrow is drawn over the cell rather
            // than laid out in it, so no column carries room for an arrow it
            // does not have - which was two characters of slack on every one.
            const header = this.textWidth(sample.header, true);
            const widest = sample.widest ? this.textWidth(sample.widest, false) : 0;
            const measured = Math.max(header, widest);
            // Nothing measurable - a hidden host, or a test with no layout -
            // so fall back to counting characters.
            const px = measured > 0 ? measured : counted[index] * FALLBACK_CHAR_PX;
            return Math.round(Math.max(MIN_COLUMN_PX, Math.min(px, cap)) + CELL_CHROME_PX);
        });
    }

    /** Measure once there is something to measure, then leave it alone. */
    private measureColumns(): void {
        if (this.state.widthsMeasured) return;
        if (this.state.columns.length === 0) return;

        const measured = this.widthsFor(this.state.rows);
        this.state.widths = measured.map((px, index) =>
            // A column the reader sized by hand keeps that width.
            this.state.pinnedWidths.has(index) ? this.state.widths[index] : px
        );
        // Header-only widths are provisional; wait for rows before fixing them.
        if (this.state.rows.length > 0) this.state.widthsMeasured = true;
        this.headSignature = '';
    }

    /**
     * Size a column to the widest value actually loaded.
     *
     * Unlike the initial measurement this reads every row rather than a sample,
     * because it is a deliberate request rather than something done while rows
     * are still arriving.
     */
    private fitColumn(index: number): void {
        const px = this.widthsFor(this.state.rows, this.state.rows.length)[index];
        if (px === undefined) return;
        this.state.widths[index] = Math.max(MIN_COLUMN_PX, px);
        this.state.pinnedWidths.add(index);
        this.renderAll();
    }

    /**
     * Push the current widths onto the cells that are already rendered.
     *
     * Used while dragging, where re-creating the header would remove the
     * element the pointer is captured on.
     */
    private applyWidthsInPlace(): void {
        for (const cell of this.elements.head.querySelectorAll<HTMLElement>('.ch-header-cell')) {
            this.applyWidth(cell, Number(cell.dataset.column));
        }
        for (const row of this.elements.body.querySelectorAll<HTMLElement>('.ch-row')) {
            const cells = row.querySelectorAll<HTMLElement>('.ch-cell:not(.ch-gutter)');
            cells.forEach((cell, index) => this.applyWidth(cell, index));
        }
        // The cached header no longer matches the state it was built from.
        this.headSignature = '';
    }

    private applyWidth(cell: HTMLElement, index: number): void {
        const px = this.state.widths[index];
        if (px === undefined) return;
        // Header and body cells are given the same number, so they cannot drift
        // apart and the header scrolls exactly as far as the body does.
        cell.style.flex = `0 0 ${px}px`;
        cell.style.width = `${px}px`;
        cell.style.minWidth = `${px}px`;
        cell.style.maxWidth = 'none';
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
                    columns: [],
                    widths: [],
                    pinnedWidths: new Set(),
                    widthsMeasured: false,
                    rows: [],
                    order: [],
                    filter: this.state.filter,
                    sort: undefined,
                    truncated: false,
                    running: true,
                    profile: message.header.profile,
                    query: message.header.query,
                    charting: false,
                };
                this.renderHead();
                this.renderAll();
                break;

            case 'columns':
                // Columns arrive after `begin`, once the server has named them.
                // The rows already streamed in must survive this.
                this.state.columns = message.columns;
                this.measureColumns();
                this.renderHead();
                this.renderAll();
                break;

            case 'rows':
                for (const row of message.rows) this.state.rows.push(row);
                this.measureColumns();
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
        this.elements.scroller.addEventListener('scroll', () => {
            this.renderBody();
            // The header is outside the scroller so it stays put vertically.
            // Horizontally it has to follow, or the labels stop lining up with
            // the columns underneath them.
            this.elements.head.scrollLeft = this.elements.scroller.scrollLeft;
        });

        this.elements.filter.addEventListener('input', () => {
            this.state.filter = this.elements.filter.value;
            this.reindex();
            this.renderAll();
        });

        this.elements.cancel.addEventListener('click', () => this.transport.post({ type: 'cancel' }));

        this.elements.chartButton.addEventListener('click', () => {
            this.state.charting = !this.state.charting;
            this.renderAll();
        });

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

        this.bindResizing();

        this.elements.head.addEventListener('click', event => {
            // A drag ends with a click on the header; sorting then would be a
            // surprise every time someone resized a column. Cleared on the
            // first click either way, so it can never swallow a later one.
            const afterDrag = this.suppressNextSort;
            this.suppressNextSort = false;
            if (afterDrag) return;
            if ((event.target as HTMLElement).dataset.resize !== undefined) return;
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
        this.renderChartView();
        this.elements.cancel.hidden = !this.state.running;
        this.elements.message.textContent = this.state.error ?? '';
        this.elements.message.hidden = !this.state.error;
    }

    /**
     * Show the chart, or offer it, or neither.
     *
     * The button only appears when the result is actually chartable, so it is
     * never a control that does nothing when pressed.
     */
    private renderChartView(): void {
        const plan = this.state.running ? undefined : planChart(this.state.columns, this.state.rows);
        this.elements.chartButton.hidden = plan === undefined;
        this.elements.chartButton.textContent = this.state.charting ? 'Rows' : 'Chart';

        const showing = plan !== undefined && this.state.charting;
        this.elements.chart.hidden = !showing;
        this.elements.scroller.hidden = showing;
        this.elements.head.hidden = showing;
        if (!showing) {
            this.elements.chart.replaceChildren();
            return;
        }

        // Charting follows the filter and the sort, so what is drawn is what
        // the rows above it would have shown.
        const rows = this.state.order.map(index => this.state.rows[index]);
        const svg = renderChart(this.state.columns, rows, plan);
        this.elements.chart.replaceChildren();
        if (!svg) {
            const empty = document.createElement('div');
            empty.className = 'ch-chart-empty';
            empty.textContent = 'Nothing numeric to plot.';
            this.elements.chart.appendChild(empty);
            return;
        }
        this.elements.chart.appendChild(svg);

        const caption = chartCaption(rows.length, chartPoints(this.state.columns, rows, plan).length);
        if (caption) {
            const note = document.createElement('div');
            note.className = 'ch-chart-caption';
            note.textContent = caption;
            this.elements.chart.appendChild(note);
        }
    }

    /** Set while a resize drag is finishing, so it does not also sort. */
    private suppressNextSort = false;

    /**
     * Drag a header edge to resize, double-click it to fit the contents.
     *
     * Pointer events with capture rather than mouse events on the document, so
     * a drag that leaves the window still ends properly.
     */
    private bindResizing(): void {
        this.elements.head.addEventListener('pointerdown', event => {
            const target = event.target as HTMLElement;
            const index = Number(target.dataset.resize);
            if (target.dataset.resize === undefined || Number.isNaN(index)) return;

            event.preventDefault();
            const startX = event.clientX;
            const startWidth = this.state.widths[index] ?? MIN_COLUMN_PX;
            target.classList.add('is-dragging');
            document.body.classList.add('ch-resizing');
            let dragged = false;

            const move = (moved: PointerEvent) => {
                const next = Math.max(MIN_COLUMN_PX, Math.round(startWidth + (moved.clientX - startX)));
                if (next === this.state.widths[index]) return;
                this.state.widths[index] = next;
                this.state.pinnedWidths.add(index);
                // Widths are fixed from here: a later batch of rows must not
                // undo what the reader just did.
                this.state.widthsMeasured = true;
                dragged = true;
                // Restyled in place rather than re-rendered: rebuilding the
                // header mid-drag would destroy the element the pointer started
                // on, and the drag would die after its first movement.
                this.applyWidthsInPlace();
            };

            const end = () => {
                target.classList.remove('is-dragging');
                document.body.classList.remove('ch-resizing');
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', end);
                window.removeEventListener('pointercancel', end);
                // Only a drag that moved something has a click to swallow, and
                // the browser dispatches that click in the same task as the
                // pointerup - so a timer set here clears the flag right after
                // it, and a drag that produces no click cannot swallow some
                // later, genuine one.
                this.suppressNextSort = dragged;
                if (dragged) setTimeout(() => (this.suppressNextSort = false), 0);
                this.renderAll();
            };

            // On the window rather than on the handle. Pointer capture would
            // also work, but only if the host grants it - and a seven pixel
            // target that only tracks while the cursor stays inside it is not a
            // drag anyone can complete.
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', end);
            window.addEventListener('pointercancel', end);
        });

        this.elements.head.addEventListener('dblclick', event => {
            const target = event.target as HTMLElement;
            if (target.dataset.resize === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            // No flag: a click on the handle is already ignored below, and
            // setting one here would swallow the reader's next sort instead.
            this.fitColumn(Number(target.dataset.resize));
        });
    }

    private headSignature = '';

    private renderHead(): void {
        const signature = `${this.state.columns.map(c => `${c.name}:${c.type}`).join('|')}#${
            this.state.sort ? `${this.state.sort.column}:${this.state.sort.direction}` : '-'
        }#${this.state.widths.join(',')}`;
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

            cell.textContent = column.name;
            cell.title = `${column.name} — ${column.type}`;

            // Drawn over the cell rather than appended to its text, so sorting
            // a column does not change how wide it is.
            if (this.state.sort?.column === index) {
                const arrow = document.createElement('span');
                arrow.className = 'ch-sort';
                arrow.textContent = this.state.sort.direction === 'asc' ? '▲' : '▼';
                cell.appendChild(arrow);
            }
            this.applyWidth(cell, index);

            // Sits on the boundary, so the whole header stays clickable for
            // sorting and only the edge resizes.
            const resizer = document.createElement('div');
            resizer.className = 'ch-resizer';
            resizer.dataset.resize = String(index);
            resizer.title = 'Drag to resize · double-click to fit the contents';
            cell.appendChild(resizer);

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
        // Re-rendering can reset the offset, so keep the header aligned.
        this.elements.head.scrollLeft = this.elements.scroller.scrollLeft;

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
            this.applyWidth(cell, columnIndex);
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
        if (stats?.memoryBytes) parts.push(`${formatBytes(stats.memoryBytes)} peak`);
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
  <button class="ch-chart-toggle" hidden>Chart</button>
</div>
<div class="ch-message" hidden></div>
<div class="ch-head"></div>
<div class="ch-scroller">
  <div class="ch-spacer"></div>
  <div class="ch-table"><div class="ch-body"></div></div>
</div>
<div class="ch-chart" hidden></div>
<div class="ch-footer"></div>
`;
