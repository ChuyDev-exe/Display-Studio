import { generateProject } from '../displays/code-export.js';
import { makeZip } from '../displays/zip.js';
import { icon } from './svg-icons.js';
import { esc } from './modal.js';

const MAX_LINES = 160; // el panel solo pinta el principio de los archivos enormes; copiar y descargar usan el texto entero
const kb = (bytes) => `${bytes.toLocaleString('es')} B`;

const ROLE_LABEL = { source: 'Código', config: 'Cabecera', asset: 'Bitmap' };

/** Colorea una línea de C con unas pocas reglas: comentarios, preprocesador, números y tipos. */
function highlight(line) {
  const safe = esc(line);
  const comment = safe.search(/\/\*|\/\/|^\s*\*/);
  const code = comment < 0 ? safe : safe.slice(0, comment);
  const tail = comment < 0 ? '' : `<span class="tk-com">${safe.slice(comment)}</span>`;
  const colored = code
    .replace(/\b(0x[0-9A-Fa-f]+|\d+)\b/g, '<span class="tk-num">$1</span>')
    .replace(/^(\s*#\w+)/, '<span class="tk-pp">$1</span>')
    .replace(/\b(const|static|extern|void|bool|uint8_t|uint16_t|uint32_t|int16_t|typedef|struct|enum|for|if|size_t)\b/g, '<span class="tk-kw">$1</span>')
    .replace(/(&quot;.*?&quot;)/g, '<span class="tk-str">$1</span>');
  return colored + tail;
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Pestaña «Código C» del dock: muestra los archivos de firmware que equivalen al diseño actual
 * y los deja copiar o descargar. Se regenera sola cuando cambia el lienzo.
 */
export class CodeView {
  #mode = 'auto'; // auto: objetos si el fotograma tiene, si no fotogramas completos
  #project = null;
  #selected = null;
  #timer = 0;
  #dirty = true;

  /**
   * @param deps.getState()  estado del editor: { config, prefs, frames, loop, objects, lcd }
   * @param deps.notify(msg) error visible
   */
  constructor(root, deps) {
    this.root = root;
    this.deps = deps;
    root.innerHTML = `
      <div class="flex h-full min-h-0 flex-col">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-ink-600 px-3 py-1.5 text-xs">
          <div data-ref="mode" class="flex items-center gap-2">
            <span class="text-2xs text-slate-500">Exportar</span>
            <div class="seg !h-6"><button type="button" data-mode="objects">Objetos</button><button type="button" data-mode="frames">Fotogramas completos</button></div>
          </div>
          <span data-ref="summary" class="min-w-0 flex-1 truncate text-2xs text-slate-500"></span>
          <button type="button" data-ref="copy" class="btn btn-ghost !h-6">${icon('copy', 'h-3.5 w-3.5')}Copiar</button>
          <button type="button" data-ref="save" class="btn btn-ghost !h-6">${icon('download', 'h-3.5 w-3.5')}Descargar</button>
          <button type="button" data-ref="zip" class="btn !h-6">${icon('download', 'h-3.5 w-3.5')}Todo en .zip</button>
        </div>
        <div data-ref="notes" class="empty:hidden border-b border-ink-600 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-200/90"></div>
        <div class="grid min-h-0 flex-1 grid-cols-[12rem_minmax(0,1fr)]">
          <div data-ref="files" role="listbox" aria-label="Archivos generados" class="min-h-0 space-y-1 overflow-y-auto border-r border-ink-600 p-1.5"></div>
          <pre data-ref="code" tabindex="0" class="m-0 min-h-0 overflow-auto bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-slate-200"></pre>
        </div>
      </div>`;
    this.$ = (selector) => root.querySelector(selector);

    this.$('[data-ref=mode]').addEventListener('click', (e) => {
      const button = e.target.closest('[data-mode]');
      if (!button) return;
      this.#mode = button.dataset.mode;
      this.#selected = null;
      this.refresh();
    });
    this.$('[data-ref=files]').addEventListener('click', (e) => {
      const button = e.target.closest('[data-file]');
      if (!button) return;
      this.#selected = button.dataset.file;
      this.#paint();
    });
    this.$('[data-ref=copy]').addEventListener('click', () => this.#copy());
    this.$('[data-ref=save]').addEventListener('click', () => {
      const file = this.#current();
      if (file) download(file.name, new Blob([file.text], { type: 'text/plain;charset=utf-8' }));
    });
    this.$('[data-ref=zip]').addEventListener('click', () => {
      if (this.#project) download('ui_firmware.zip', makeZip(this.#project.files));
    });
  }

  /** El dock avisa de que cambió algo: solo se regenera si la pestaña está a la vista. */
  schedule() {
    this.#dirty = true;
    if (this.root.hidden) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.refresh(), 250);
  }

  refresh() {
    this.#dirty = false;
    const state = this.deps.getState();
    const graphic = state.config.mode === 'graphic';
    const mode = this.#mode === 'auto' ? (state.objects?.length ? 'objects' : 'frames') : this.#mode;
    try {
      this.#project = generateProject({ ...state, mode });
    } catch (error) {
      this.deps.notify(`No se pudo generar el código: ${error.message}`);
      return;
    }
    this.$('[data-ref=mode]').hidden = !graphic;
    this.$('[data-ref=mode]').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    this.#mode = this.#mode === 'auto' ? 'auto' : mode;
    this.#project.mode = mode;
    this.#paint();
  }

  /** Al abrir la pestaña, pone al día lo que cambió mientras estaba oculta. */
  show() {
    if (this.#dirty || !this.#project) this.refresh();
  }

  #current() {
    const files = this.#project?.files ?? [];
    return files.find((f) => f.name === this.#selected) ?? files[0];
  }

  #paint() {
    const { files, notes, flash } = this.#project;
    const current = this.#current();
    this.#selected = current?.name ?? null;

    const summary = [`${files.length} archivo${files.length === 1 ? '' : 's'}`];
    if (flash) summary.push(`${kb(flash)} de bitmaps en flash`);
    this.$('[data-ref=summary]').textContent = summary.join(' · ');
    this.$('[data-ref=notes]').innerHTML = notes.map((n) => `<p>${esc(n)}</p>`).join('');

    this.$('[data-ref=files]').replaceChildren(
      ...files.map((file) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.file = file.name;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(file === current));
        button.className = 'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-slate-300 hover:bg-white/5 aria-selected:bg-accent-soft aria-selected:text-accent-strong';
        const thumb = file.preview ? '<canvas class="pixelated h-8 w-8 shrink-0 rounded-sm bg-black object-contain ring-1 ring-ink-500"></canvas>' : '';
        button.innerHTML = `${thumb}<span class="min-w-0"><span class="block truncate font-mono">${esc(file.name)}</span>
          <span class="block text-[10px] text-slate-500">${ROLE_LABEL[file.role]}${file.bytes ? ` · ${kb(file.bytes)}` : ''}</span></span>`;
        if (file.preview) {
          const canvas = button.querySelector('canvas');
          canvas.width = file.preview.width;
          canvas.height = file.preview.height;
          canvas.getContext('2d').putImageData(file.preview, 0, 0);
        }
        return button;
      }),
    );

    const lines = current ? current.text.split('\n') : [];
    const shown = lines.slice(0, MAX_LINES).map(highlight).join('\n');
    const more = lines.length > MAX_LINES
      ? `\n<span class="text-slate-500">// … ${(lines.length - MAX_LINES).toLocaleString('es')} líneas más: «Copiar» y «Descargar» incluyen el archivo completo.</span>`
      : '';
    this.$('[data-ref=code]').innerHTML = (shown + more) || '<span class="text-slate-500">// Nada que exportar todavía.</span>';
  }

  async #copy() {
    const file = this.#current();
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.text);
    } catch (error) {
      this.deps.notify(`No se pudo copiar: ${error.message}`);
    }
  }
}
