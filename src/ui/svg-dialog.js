import { LIBRARIES, listIcons, loadIcon, normalizeSvg } from './svg-library.js';
import { icon } from './svg-icons.js';
import { createModal, modalButton } from './modal.js';

const PAGE = 48;
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Selector de SVG: bibliotecas de npm con búsqueda, archivo local o código pegado. */
export class SvgDialog {
  #source = 'lucide';
  #results = [];
  #shown = 0;
  #selected = null; // { raw, name }
  #search = 0;

  constructor({ onPlace }) {
    this.onPlace = onPlace;
    this.modal = createModal({ title: 'Insertar SVG', size: 'max-w-4xl', persistent: true, bodyClass: 'p-0 !overflow-hidden' });
    this.root = this.modal.body;
    this.root.innerHTML = `
      <div class="flex h-[min(64vh,560px)] min-h-0 flex-col">
        <div class="flex shrink-0 items-center gap-1 border-b border-ink-600 px-3" role="tablist">
          ${LIBRARIES.map((l) => this.#tab(l.id, l.label)).join('')}${this.#tab('file', 'Archivo o código')}
        </div>
        <div class="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_14rem]">
          <div class="flex min-h-0 flex-col">
            <div data-ref="library-bar" class="flex items-center gap-2 p-3 pb-2">
              <div class="relative flex-1">
                <span class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-500">${icon('grid', 'h-3.5 w-3.5')}</span>
                <input data-ref="query" type="search" placeholder="Buscar ícono: heart, wifi, battery" class="input !pl-7" autocomplete="off" aria-label="Buscar ícono" />
              </div>
              <span data-ref="count" class="shrink-0 text-2xs tabular-nums text-slate-500"></span>
            </div>
            <div data-ref="grid" class="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(4rem,1fr))] content-start gap-1 overflow-y-auto px-3 pb-3"></div>
            <div data-ref="file-box" class="hidden space-y-3 p-3">
              <label class="btn w-fit cursor-pointer">${icon('upload', 'h-3.5 w-3.5')}Elegir archivo .svg<input data-ref="file" type="file" accept=".svg,image/svg+xml" class="sr-only" /></label>
              <div><label class="field-label" for="svg-code">O pega el código SVG</label>
                <textarea id="svg-code" data-ref="code" rows="8" class="input font-mono" spellcheck="false" placeholder="&lt;svg viewBox=&quot;0 0 24 24&quot;&gt;...&lt;/svg&gt;"></textarea></div>
              <button type="button" data-ref="use-code" class="btn">Usar este SVG</button>
            </div>
          </div>
          <div class="flex min-h-0 flex-col gap-3 overflow-y-auto border-t border-ink-600 p-3 md:border-l md:border-t-0">
            <div class="bench grid h-32 place-items-center rounded-lg border border-ink-600"><img data-ref="preview" alt="" class="h-20 w-20 object-contain" hidden /><span data-ref="none" class="text-2xs text-slate-500">Elige un ícono</span></div>
            <p data-ref="name" class="truncate text-xs font-medium text-slate-200"></p>
            <div data-ref="color-field"><label class="field-label" for="svg-color">Color</label>
              <input id="svg-color" data-ref="color" type="color" value="#ffffff" class="swatch !w-full" /></div>
            <div data-ref="stroke-field"><div class="flex justify-between"><label class="field-label" for="svg-stroke">Grosor del trazo</label><output data-ref="stroke-value" class="text-2xs tabular-nums text-slate-400">2</output></div>
              <input id="svg-stroke" data-ref="stroke" type="range" min="0.5" max="4" step="0.5" value="2" class="w-full" /></div>
          </div>
        </div>
      </div>`;
    this.placeButton = modalButton('', 'btn-accent');
    this.placeButton.innerHTML = `${icon('check', 'h-3.5 w-3.5')}Colocar en el lienzo`;
    this.placeButton.disabled = true;
    this.modal.footer.append(modalButton('Cancelar', 'btn-ghost', () => this.close()), this.placeButton);
    this.#bind();
  }

  #tab(id, label) {
    return `<button type="button" role="tab" data-source="${id}" aria-selected="${id === this.#source}" class="tab">${label}</button>`;
  }

  $(selector) {
    return this.root.querySelector(selector);
  }

  /** `monochrome`: el color se fija en `ink` (blanco enciende un OLED; negro es tinta en e-paper). */
  open({ monochrome, ink = '#ffffff' }) {
    this.monochrome = monochrome;
    this.ink = ink;
    this.$('[data-ref=color-field]').hidden = monochrome;
    if (monochrome) this.$('[data-ref=color]').value = ink;
    this.modal.open();
    if (!this.#results.length) this.#setSource(this.#source);
    this.$('[data-ref=query]').focus();
  }

  close() {
    this.modal.close();
  }

  #bind() {
    this.root.querySelectorAll('[data-source]').forEach((b) => b.addEventListener('click', () => this.#setSource(b.dataset.source)));
    this.$('[data-ref=query]').addEventListener('input', () => {
      clearTimeout(this.#search);
      this.#search = setTimeout(() => this.#runSearch(), 150);
    });
    this.$('[data-ref=grid]').addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      if (more) return this.#renderPage();
      const cell = e.target.closest('[data-path]');
      if (!cell) return;
      this.$('[data-ref=grid]').querySelectorAll('[aria-pressed=true]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      cell.setAttribute('aria-pressed', 'true');
      this.#pick(cell.dataset.path, cell.dataset.name);
    });
    this.$('[data-ref=color]').addEventListener('input', () => this.#refreshPreview());
    this.$('[data-ref=stroke]').addEventListener('input', (e) => {
      this.$('[data-ref=stroke-value]').textContent = e.target.value;
      this.#refreshPreview();
    });
    this.$('[data-ref=file]').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) this.#use(await file.text(), file.name.replace(/\.svg$/i, ''));
    });
    this.$('[data-ref=use-code]').addEventListener('click', () => this.#use(this.$('[data-ref=code]').value, 'SVG pegado'));
    this.placeButton.addEventListener('click', () => {
      this.onPlace({ raw: this.#selected.raw, name: this.#selected.name, ...this.options() });
      this.close();
    });
  }

  options() {
    return {
      color: this.monochrome ? this.ink : this.$('[data-ref=color]').value,
      strokeWidth: Number(this.$('[data-ref=stroke]').value),
    };
  }

  #setSource(source) {
    this.#source = source;
    this.root.querySelectorAll('[data-source]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.source === source)));
    const isFile = source === 'file';
    // `hidden` como clase: los atributos [hidden] pierden frente a las utilidades flex/grid.
    this.$('[data-ref=file-box]').classList.toggle('hidden', !isFile);
    this.$('[data-ref=grid]').classList.toggle('hidden', isFile);
    this.$('[data-ref=library-bar]').classList.toggle('hidden', isFile);
    if (!isFile) {
      this.#results = listIcons(source);
      this.$('[data-ref=query]').value = '';
      this.#runSearch();
    }
  }

  #runSearch() {
    const query = this.$('[data-ref=query]').value.trim().toLowerCase();
    this.#results = listIcons(this.#source).filter((i) => i.name.includes(query));
    this.$('[data-ref=count]').textContent = `${this.#results.length.toLocaleString('es')} íconos`;
    this.$('[data-ref=grid]').replaceChildren();
    this.#shown = 0;
    this.#renderPage();
  }

  async #renderPage() {
    const grid = this.$('[data-ref=grid]');
    grid.querySelector('[data-more]')?.remove();
    const batch = this.#results.slice(this.#shown, this.#shown + PAGE);
    this.#shown += batch.length;

    const cells = batch.map(({ name, path }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.path = path;
      button.dataset.name = name;
      button.title = name;
      button.className = 'flex aspect-square flex-col items-center justify-center gap-1.5 rounded-md border border-transparent p-1.5 text-slate-500 transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-slate-300 aria-pressed:border-accent/60 aria-pressed:bg-accent-soft aria-pressed:text-accent-strong';
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = `<span class="h-6 w-6"></span><span class="w-full truncate text-center text-[9px]">${esc(name)}</span>`;
      grid.append(button);
      return button;
    });
    if (this.#shown < this.#results.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.dataset.more = '1';
      more.className = 'btn btn-ghost col-span-full';
      more.textContent = `Mostrar más (${this.#results.length - this.#shown})`;
      grid.append(more);
    }

    // Los módulos de los íconos se cargan bajo demanda, solo los de esta página.
    const source = this.#source;
    await Promise.all(cells.map(async (button) => {
      try {
        const raw = await loadIcon(source, button.dataset.path);
        const { svg } = normalizeSvg(raw, { color: '#e2e8f0' });
        button.firstElementChild.innerHTML = `<img src="${dataUrl(svg)}" alt="" class="h-6 w-6 object-contain" />`;
      } catch {
        button.firstElementChild.textContent = '?';
      }
    }));
  }

  async #pick(path, name) {
    try {
      this.#select(await loadIcon(this.#source, path), name);
    } catch (error) {
      this.#fail(error);
    }
  }

  #use(raw, name) {
    try {
      this.#select(raw, name);
    } catch (error) {
      this.#fail(error);
    }
  }

  #select(raw, name) {
    normalizeSvg(raw); // valida antes de aceptarlo
    this.#selected = { raw, name };
    this.$('[data-ref=name]').textContent = name;
    this.placeButton.disabled = false;
    this.$('[data-ref=stroke-field]').hidden = !/stroke=/.test(raw.slice(0, 600));
    this.#refreshPreview();
  }

  #fail(error) {
    this.#selected = null;
    this.placeButton.disabled = true;
    this.$('[data-ref=name]').textContent = error.message;
  }

  #refreshPreview() {
    if (!this.#selected) return;
    const preview = this.$('[data-ref=preview]');
    const { color, strokeWidth } = this.options();
    // Sobre fondo oscuro un color muy oscuro no se vería: la vista previa solo avisa, no cambia el color.
    preview.src = dataUrl(normalizeSvg(this.#selected.raw, { color, strokeWidth }).svg);
    preview.hidden = false;
    this.$('[data-ref=none]').hidden = true;
  }
}
