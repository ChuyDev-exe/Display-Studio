import { tokensToText } from '../displays/bus-encoder.js';
import { BUS_LABELS, CLOCK_OPTIONS } from '../displays/display-configs.js';
import { icon } from './svg-icons.js';

const MAX_ROWS = 1500;

const KIND_BADGE = {
  CMD: 'bg-accent/15 text-accent-strong',
  DATA: 'bg-emerald-500/20 text-emerald-300',
  WAIT: 'bg-amber-500/20 text-amber-300',
  INFO: 'bg-slate-500/20 text-slate-400',
};
const BYTE_STYLE = {
  CMD: 'border-accent/40 bg-accent/10 text-accent-strong',
  DATA: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200',
  WAIT: 'border-ink-500 text-slate-300',
  INFO: 'border-ink-500 text-slate-300',
};

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const H2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** Dibuja un token del bus como chip (bytes, señales, bits individuales). */
function renderToken(token, kind) {
  switch (token.t) {
    case 'ctl':
      return `<span class="rounded border border-ink-500 px-1 text-[10px] font-semibold tracking-wide text-slate-400">${esc(token.text)}</span>`;
    case 'addr':
      return `<span class="rounded border border-amber-400/40 bg-amber-500/10 px-1.5 font-semibold text-amber-300" title="Dirección I2C de 7 bits 0x${H2(token.byte >> 1)} + bit ${token.rw}">0x${H2(token.byte)} ${token.rw}</span>`;
    case 'byte':
      return `<span class="rounded border px-1.5 ${BYTE_STYLE[kind]}">${H2(token.v)}</span>`;
    case 'sig':
      return `<span class="inline-flex overflow-hidden rounded border border-ink-500 text-[10px]"><span class="bg-ink-800 px-1 text-slate-400">${token.name}</span><span class="px-1 font-bold ${token.value ? 'bg-accent/25 text-accent-strong' : 'text-slate-500'}">${token.value}</span></span>`;
    case 'bits': {
      const boxes = token.value.toString(2).padStart(token.width, '0').split('')
        .map((b) => `<span class="grid h-4 w-3.5 place-items-center text-[10px] font-bold ${b === '1' ? 'bg-accent text-ink-950' : 'bg-ink-700 text-slate-500'}">${b}</span>`).join('');
      return `<span class="inline-flex items-center gap-1"><span class="text-[10px] text-slate-500">${token.name}</span><span class="inline-flex gap-px overflow-hidden rounded">${boxes}</span></span>`;
    }
    case 'pulse':
      return `<span class="inline-flex items-center gap-0.5 rounded border border-violet-400/40 bg-violet-500/10 px-1 text-[10px] font-semibold text-violet-300" title="Pulso en ${token.text}: nivel alto y luego bajo">${token.text}${icon('pulse', 'h-3 w-3')}</span>`;
    case 'more':
      return `<span class="text-slate-500">… +${token.n.toLocaleString('es')} B</span>`;
    default:
      return '<span class="mx-1 inline-block h-3 w-px bg-ink-500 align-middle"></span>';
  }
}

/** Inspector de bus: controles (fuente, interfaz, reloj) y tabla de transacciones. */
export class BusView {
  #rows = [];
  #collapsed = new Set(); // títulos de grupos contraídos
  #expanded = new Set(); // filas con detalle abierto (índice)

  constructor(root, { onChange, onCopyError }) {
    this.onChange = onChange;
    this.onCopyError = onCopyError;
    root.innerHTML = `
      <div class="flex h-full min-h-0 flex-col">
        <div data-ref="controls" class="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-ink-600 px-3 py-2"></div>
        <div class="grid min-h-0 flex-1 gap-px bg-ink-600 md:grid-cols-[minmax(14rem,3fr)_minmax(0,7fr)]">
          <div class="flex min-h-0 flex-col bg-ink-900">
            <p class="px-3 pt-2 text-2xs font-medium text-slate-400">USB, del PC al ESP32</p>
            <div data-ref="usb" class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-2 pt-1.5"></div>
          </div>
          <div class="flex min-h-0 flex-col bg-ink-900">
            <div class="flex items-center justify-between gap-2 px-3 pt-2">
              <p data-ref="bus-title" class="text-2xs font-medium text-slate-400"></p>
              <div class="flex gap-1 text-[11px]">
                <button type="button" data-ref="expand-all" class="btn btn-ghost !h-6 !px-1.5 text-2xs">Expandir todo</button>
                <button type="button" data-ref="collapse-all" class="btn btn-ghost !h-6 !px-1.5 text-2xs">Contraer todo</button>
              </div>
            </div>
            <div data-ref="rows" class="min-h-0 flex-1 overflow-auto px-2 pb-1 pt-1.5 font-mono text-xs" tabindex="0" role="table" aria-label="Transacciones del bus"></div>
            <p data-ref="summary" class="border-t border-ink-600 px-3 py-1.5 text-2xs tabular-nums text-slate-400"></p>
          </div>
        </div>
      </div>`;
    this.controls = root.querySelector('[data-ref=controls]');
    this.usbEl = root.querySelector('[data-ref=usb]');
    this.rowsEl = root.querySelector('[data-ref=rows]');
    this.summaryEl = root.querySelector('[data-ref=summary]');
    this.titleEl = root.querySelector('[data-ref=bus-title]');

    this.rowsEl.addEventListener('click', (e) => {
      const group = e.target.closest('[data-group-title]');
      if (group) return this.#toggleGroup(group.dataset.groupTitle);
      const row = e.target.closest('[data-row]');
      if (row && row.dataset.hasDetail) this.#toggleRow(Number(row.dataset.row));
    });
    root.querySelector('[data-ref=expand-all]').addEventListener('click', () => {
      this.#collapsed.clear();
      this.#rows.forEach((r, i) => r.detail?.length && this.#expanded.add(i));
      this.#paint();
    });
    root.querySelector('[data-ref=collapse-all]').addEventListener('click', () => {
      this.#expanded.clear();
      this.#rows.forEach((r) => r.kind === 'GROUP' && this.#collapsed.add(r.desc));
      this.#paint();
    });
  }

  /** Redibuja los controles. `state` = { source, bus, addr, clock, includeInit }. */
  setContext(config, state, sources) {
    const showAddr = state.bus === 'i2c';
    const clocks = CLOCK_OPTIONS[state.bus];
    this.controls.innerHTML = `
      <div><label class="field-label" for="bus-source">Qué se envía</label>
        <select id="bus-source" class="input !w-auto">${sources
          .map((s) => `<option value="${s.id}" ${s.id === state.source ? 'selected' : ''}>${s.label}</option>`)
          .join('')}</select></div>
      <div role="group" aria-label="Interfaz con la pantalla"><span class="field-label">Interfaz</span>
        <div class="seg">${config.buses
          .map((bus) => `<button type="button" data-bus="${bus}" aria-pressed="${bus === state.bus}" class="!px-2.5">${BUS_LABELS[bus]}</button>`)
          .join('')}</div></div>
      ${showAddr ? `<div><label class="field-label" for="bus-addr">Dirección I2C</label>
        <input id="bus-addr" value="0x${state.addr.toString(16).toUpperCase()}" class="input !w-20 font-mono" spellcheck="false" /></div>` : ''}
      ${clocks ? `<div><label class="field-label" for="bus-clock">Reloj</label>
        <select id="bus-clock" class="input !w-auto">${clocks
          .map((c) => `<option value="${c}" ${c === state.clock ? 'selected' : ''}>${c} ${state.bus === 'i2c' ? 'kHz' : 'MHz'}</option>`)
          .join('')}</select></div>` : ''}
      <label class="flex h-7 items-center gap-2 text-xs text-slate-300"><input type="checkbox" id="bus-init" ${state.includeInit ? 'checked' : ''} />Incluir inicialización</label>
      <button type="button" data-ref="copy" class="btn btn-ghost ml-auto">${icon('copy', 'h-3.5 w-3.5')}Copiar</button>`;

    const $ = (selector) => this.controls.querySelector(selector);
    $('#bus-source').addEventListener('change', (e) => this.onChange({ source: e.target.value }));
    this.controls.querySelectorAll('[data-bus]').forEach((b) =>
      b.addEventListener('click', () => this.onChange({ bus: b.dataset.bus })),
    );
    $('#bus-addr')?.addEventListener('change', (e) => {
      const value = parseInt(e.target.value, 16);
      if (value >= 0x08 && value <= 0x77) this.onChange({ addr: value });
      else e.target.value = `0x${state.addr.toString(16).toUpperCase()}`; // dirección I2C de 7 bits no válida
    });
    $('#bus-clock')?.addEventListener('change', (e) => this.onChange({ clock: Number(e.target.value) }));
    $('#bus-init').addEventListener('change', (e) => this.onChange({ includeInit: e.target.checked }));
    $('[data-ref=copy]').addEventListener('click', () => this.#copy());
    this.titleEl.textContent = `Del ESP32 a la pantalla por ${BUS_LABELS[state.bus]}`;
  }

  show({ usb, rows, summary }) {
    this.#rows = rows;
    this.usbEl.innerHTML = usb.map((line) => this.#usbMessage(line)).join('');
    this.summaryEl.textContent = summary;
    this.#paint();
  }

  #usbMessage(line) {
    let name = '';
    let body = esc(line);
    try {
      const parsed = JSON.parse(line);
      name = parsed.cmd ?? '';
      body = esc(JSON.stringify(parsed)).replace(/&quot;(\w+)&quot;:/g, '<span class="text-slate-500">$1</span>:');
    } catch {
      /* línea de texto, no JSON */
    }
    return `<div class="rounded-md border border-ink-600 bg-ink-950 px-2 py-1.5">
      ${name ? `<span class="mb-1 inline-block rounded bg-accent-soft px-1.5 font-mono text-[10px] font-medium text-accent-strong">${esc(name)}</span>` : ''}
      <p class="break-all font-mono text-[11px] leading-snug text-slate-300">${body}</p></div>`;
  }

  #toggleGroup(title) {
    if (!this.#collapsed.delete(title)) this.#collapsed.add(title);
    this.#paint();
  }

  #toggleRow(index) {
    if (!this.#expanded.delete(index)) this.#expanded.add(index);
    this.#paint();
  }

  #paint() {
    const scroll = this.rowsEl.scrollTop;
    const rows = this.#rows.slice(0, MAX_ROWS);
    const html = [];
    let hidden = false;
    const counts = new Map();
    rows.forEach((r) => r.kind !== 'GROUP' && counts.set(r.groupId, (counts.get(r.groupId) ?? 0) + 1));

    rows.forEach((row, i) => {
      if (row.kind === 'GROUP') {
        hidden = this.#collapsed.has(row.desc);
        html.push(`<button type="button" data-group-title="${esc(row.desc)}" aria-expanded="${!hidden}" class="mt-1.5 flex w-full items-center gap-2 rounded-md bg-ink-800 px-2 py-1 text-left font-sans text-2xs font-medium text-slate-300 first:mt-0 hover:bg-ink-700">
          <span class="text-slate-500">${icon(hidden ? 'chevron-right' : 'chevron-down', 'h-3 w-3')}</span><span class="min-w-0 flex-1 truncate">${esc(row.desc)}</span><span class="font-normal text-slate-500">${counts.get(row.groupId) ?? 0}</span></button>`);
        return;
      }
      if (hidden) return;
      const open = this.#expanded.has(i);
      const hasDetail = row.detail?.length > 0;
      const tokens = row.tokens.map((t) => renderToken(t, row.kind)).join('<span class="w-1"></span>');
      html.push(`<div data-row="${i}" ${hasDetail ? 'data-has-detail="1"' : ''} role="row" class="grid grid-cols-[1.75rem_2.75rem_minmax(0,1fr)] items-start gap-x-2 border-b border-ink-700/50 py-1 ${hasDetail ? 'cursor-pointer hover:bg-white/[.03]' : ''}">
        <span class="pt-0.5 text-right text-[10px] text-slate-600">${i + 1}</span>
        <span class="mt-0.5 rounded px-1 text-center text-[10px] font-semibold ${KIND_BADGE[row.kind]}">${row.kind}</span>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-y-1">${tokens}</div>
          ${row.desc ? `<p class="mt-0.5 font-sans text-[11px] leading-snug text-slate-400">${hasDetail ? `<span class="mr-0.5 inline-block align-[-2px] text-slate-600">${icon(open ? 'chevron-down' : 'chevron-right', 'h-3 w-3')}</span>` : ''}${esc(row.desc)}</p>` : ''}
          ${open ? `<pre class="mt-1 overflow-x-auto rounded bg-ink-950 p-2 text-[11px] leading-relaxed text-slate-300">${esc(row.detail.join('\n'))}</pre>` : ''}
        </div></div>`);
    });
    if (this.#rows.length > MAX_ROWS) html.push(`<p class="p-2 text-slate-500">… ${this.#rows.length - MAX_ROWS} filas más (usa Copiar para ver todo).</p>`);
    this.rowsEl.innerHTML = html.join('');
    this.rowsEl.scrollTop = scroll;
  }

  async #copy() {
    const text = this.#rows
      .map((r, i) => (r.kind === 'GROUP' ? `\n# ${r.desc}` : `${i + 1}\t${r.kind}\t${tokensToText(r.tokens)}\t${r.desc}`))
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      this.onCopyError(error);
    }
  }
}
