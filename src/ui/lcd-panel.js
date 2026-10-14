import {
  GLYPH_COLS, GLYPH_MARKS, GLYPH_ROWS, GLYPH_SLOTS, ROM_SPECIALS, sanitizeText,
} from '../displays/lcd-editor.js';
import { decodeFile, fileKind, imageToGlyph } from '../displays/image-import.js';
import { PRESETS } from '../displays/lcd-animation.js';
import { icon } from './svg-icons.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attr = (text) => text.replace(/"/g, '&quot;');
const TABS = [
  ['text', 'Texto', 'type'],
  ['glyph', 'Caracteres', 'grid'],
  ['anim', 'Animación', 'film'],
];

/** Editor del LCD de caracteres: pestañas Texto, Caracteres personalizados y Animación. */
export class LcdPanel {
  tab = 'text';
  playing = false;
  speed = 1;
  #run = 0;
  #lastInput = null;

  /**
   * @param deps.send(commands, { quiet })  envía (o simula) comandos JSON
   * @param deps.onChange()                 el contenido cambió: refrescar vista previa e inspector
   * @param deps.onTab(tab)                 se cambió de pestaña
   * @param deps.notify(message)            error visible para el usuario
   */
  constructor(root, { lcd, animation, previewCanvas, send, onChange, onTab, notify }) {
    this.root = root;
    this.lcd = lcd;
    this.animation = animation;
    this.previewCanvas = previewCanvas;
    this.deps = { send, onChange, onTab, notify };
    this.#build();
    this.#bind();
    this.#bindDrop();
  }

  $(selector) {
    return this.root.querySelector(selector);
  }

  // ---------------------------------------------------------------- API pública

  setDisplay(config) {
    this.stop();
    this.config = config;
    this.lcd.setDisplay(config);
    this.animation.setDisplay(config);
    this.#buildLines();
    this.#buildFrameEditor();
    this.$('[data-ref=place-col]').max = String(config.cols - 1);
    this.$('[data-ref=place-row]').max = String(config.rows - 1);
    for (const ref of ['place-col', 'place-row']) {
      const input = this.$(`[data-ref=${ref}]`);
      input.value = String(Math.min(Number(input.value), Number(input.max)));
    }
    const rowSelect = this.$('[data-ref=preset-row]');
    rowSelect.innerHTML = Array.from({ length: config.rows }, (_, i) => `<option value="${i}">Fila ${i + 1}</option>`).join('');
    this.#updateGlyphUi();
    this.#onPresetChange();
  }

  /** Comandos pendientes para el inspector: 'content' | 'glyph' | 'place' | 'anim'. */
  commandsFor(source) {
    if (source === 'glyph') return [this.lcd.glyphCommand()];
    if (source === 'anim') return this.animation.compileFrame(this.animation.selected);
    if (source === 'place') {
      try {
        return [this.#placeCommand()];
      } catch {
        return [];
      }
    }
    return this.lcd.textCommands();
  }

  /** Acción del botón "Enviar contenido" según la pestaña visible. */
  async sendCurrent() {
    if (this.tab === 'glyph') return this.#saveGlyph();
    if (this.tab === 'anim') return this.deps.send(this.animation.compileFrame(this.animation.selected));
    return this.#sendText();
  }

  clear() {
    this.stop();
    this.lcd.clearScreen();
    this.#buildLines();
    this.deps.onChange();
  }

  stop() {
    this.#run++; // invalida cualquier bucle de reproducción en curso
    if (!this.playing) return;
    this.playing = false;
    this.#updatePlayButton();
    this.renderPreview();
  }

  renderPreview() {
    const anim = this.animation;
    if (this.tab === 'anim') {
      this.lcd.render(this.previewCanvas, {
        lines: anim.frame.lines,
        glyphs: anim.glyphTableAt(anim.selected, this.lcd.glyphs),
        placed: new Map(),
      });
    } else {
      this.lcd.render(this.previewCanvas);
    }
    this.#updateThumbs();
  }

  // ------------------------------------------------------------------ plantilla

  #build() {
    const slotOptions = Array.from({ length: GLYPH_SLOTS }, (_, i) => `<option value="${i}">${i}</option>`).join('');
    this.root.innerHTML = `
      <div class="flex h-full min-h-0 flex-col">
        <div class="flex h-10 shrink-0 items-center gap-1 border-b border-ink-600 px-2" role="tablist" aria-label="Editor del LCD">
          ${TABS.map(([id, label, ico]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === this.tab}" class="tab !h-10">${icon(ico, 'h-3.5 w-3.5')}${label}</button>`).join('')}
        </div>

        <div data-ref="palette" class="flex items-center gap-0.5 overflow-x-auto border-b border-ink-600 bg-ink-950 px-2 py-1" role="group" aria-label="Insertar carácter especial">
          <span class="shrink-0 pr-2 text-2xs text-slate-500">Insertar</span>
          ${GLYPH_MARKS.map((mark, slot) => `<button type="button" data-insert="${mark}" title="Glifo personalizado ${slot}" class="btn btn-ghost btn-icon !h-6 !w-6 font-mono !text-accent">${mark}</button>`).join('')}
          <span class="divider-v mx-1"></span>
          ${ROM_SPECIALS.map((s) => `<button type="button" data-insert="${s.char}" title="${s.name} (0x${s.code.toString(16).toUpperCase()})" class="btn btn-ghost btn-icon !h-6 !w-6 font-mono">${s.char}</button>`).join('')}
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          <div data-panel="text" role="tabpanel" class="space-y-2">
            <div data-ref="lcd-lines" class="space-y-2"></div>
            <div class="flex items-center justify-between gap-3 pt-1">
              <p class="text-2xs text-slate-500">Los caracteres especiales y los glifos personalizados se envían con "lcdRaw".</p>
              <button type="button" data-ref="send-text" data-needs-idle class="btn btn-accent">${icon('send', 'h-3.5 w-3.5')}Enviar texto</button>
            </div>
          </div>

          <div data-panel="glyph" role="tabpanel" hidden>
            <div class="flex flex-wrap items-start gap-x-6 gap-y-3">
              <div>
                <p class="field-label">Slot CGRAM</p>
                <div data-ref="glyph-slots" class="grid grid-cols-4 gap-1" role="group" aria-label="Slots 0 a 7"></div>
              </div>
              <div>
                <p class="field-label">Cuadrícula 5 x 8</p>
                <div data-ref="glyph-grid" class="grid w-36 grid-cols-5 gap-1" role="group" aria-label="Cuadrícula 5 por 8"></div>
              </div>
              <div class="min-w-[14rem] flex-1 space-y-3">
                <code data-ref="glyph-rows" class="block rounded-md border border-ink-600 bg-ink-950 px-2.5 py-1.5 font-mono text-2xs text-slate-300"></code>
                <div class="flex flex-wrap gap-2">
                  <button type="button" data-ref="glyph-save" data-needs-idle class="btn btn-accent">${icon('send', 'h-3.5 w-3.5')}Guardar carácter</button>
                  <button type="button" data-ref="glyph-clear" class="btn btn-ghost">${icon('eraser', 'h-3.5 w-3.5')}Vaciar</button>
                  <button type="button" data-ref="glyph-invert" class="btn btn-ghost">${icon('invert', 'h-3.5 w-3.5')}Invertir</button>
                </div>
                <fieldset class="rounded-lg border border-ink-600 p-2.5">
                  <legend class="px-1 text-2xs font-medium text-slate-400">Colocar en el LCD</legend>
                  <div class="grid grid-cols-4 gap-2">
                    <div><label class="field-label" for="place-slot">Slot</label><select id="place-slot" data-ref="place-slot" class="input">${slotOptions}</select></div>
                    <div><label class="field-label" for="place-col">Col</label><input id="place-col" data-ref="place-col" type="number" min="0" value="0" class="input" /></div>
                    <div><label class="field-label" for="place-row">Fila</label><input id="place-row" data-ref="place-row" type="number" min="0" value="0" class="input" /></div>
                    <div class="flex items-end"><button type="button" data-ref="place-send" data-needs-idle class="btn w-full">Colocar</button></div>
                  </div>
                </fieldset>
              </div>
            </div>
          </div>

          <div data-panel="anim" role="tabpanel" class="space-y-3" hidden>
            <div class="flex flex-wrap items-end gap-2">
              <div><label class="field-label" for="preset">Generador</label>
                <select id="preset" data-ref="preset" class="input !w-auto">${PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select></div>
              <div class="min-w-[8rem] flex-1"><label class="field-label" for="preset-text">Texto</label>
                <input id="preset-text" data-ref="preset-text" class="input" autocomplete="off" /></div>
              <div><label class="field-label" for="preset-row">Fila</label><select id="preset-row" data-ref="preset-row" class="input !w-auto"></select></div>
              <button type="button" data-ref="preset-go" class="btn">${icon('wand', 'h-3.5 w-3.5')}Generar</button>
              <span class="divider-v mx-1 hidden self-center sm:block"></span>
              <button type="button" data-ref="play" class="btn"></button>
              <label class="btn btn-ghost btn-icon cursor-pointer has-[:checked]:!text-accent has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-accent" title="Repetir en bucle"><input type="checkbox" data-ref="loop" checked class="sr-only" />${icon('repeat', 'h-3.5 w-3.5')}<span class="sr-only">Bucle</span></label>
              <div><label class="field-label" for="speed">Velocidad</label>
                <select id="speed" data-ref="speed" class="input !w-auto">${[0.25, 0.5, 1, 2, 4].map((v) => `<option value="${v}" ${v === 1 ? 'selected' : ''}>${v}x</option>`).join('')}</select></div>
            </div>

            <div class="flex items-center gap-2">
              <div data-ref="frame-strip" class="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1" role="listbox" aria-label="Frames"></div>
              <button type="button" data-ref="frame-add" class="btn btn-ghost btn-icon " title="Nuevo frame vacío" aria-label="Nuevo frame vacío">${icon('plus', 'h-3.5 w-3.5')}</button>
              <button type="button" data-ref="frame-dup" class="btn btn-ghost btn-icon " title="Duplicar frame" aria-label="Duplicar frame">${icon('copy', 'h-3.5 w-3.5')}</button>
              <button type="button" data-ref="frame-left" class="btn btn-ghost btn-icon " title="Mover a la izquierda" aria-label="Mover a la izquierda">${icon('chevron-left', 'h-3.5 w-3.5')}</button>
              <button type="button" data-ref="frame-right" class="btn btn-ghost btn-icon " title="Mover a la derecha" aria-label="Mover a la derecha">${icon('chevron-right', 'h-3.5 w-3.5')}</button>
              <button type="button" data-ref="frame-del" class="btn btn-ghost btn-icon hover:!text-red-300" title="Eliminar frame" aria-label="Eliminar frame">${icon('trash', 'h-3.5 w-3.5')}</button>
            </div>

            <div class="rounded-lg border border-ink-600 p-2.5">
              <div class="flex flex-wrap items-end justify-between gap-2 pb-2">
                <p data-ref="frame-title" class="text-xs font-medium text-slate-200"></p>
                <div class="flex items-end gap-2">
                  <div><label class="field-label" for="frame-ms">Duración (ms)</label><input id="frame-ms" data-ref="frame-ms" type="number" min="20" max="10000" step="10" class="input !w-24" /></div>
                  <button type="button" data-ref="ms-all" class="btn btn-ghost">Aplicar a todos</button>
                </div>
              </div>
              <div data-ref="frame-lines" class="space-y-1.5"></div>
              <div class="mt-2 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-2">
                <span class="text-2xs text-slate-500">Glifos del frame</span>
                <div data-ref="frame-glyphs" class="flex flex-wrap gap-1"></div>
                <select data-ref="frame-glyph-slot" class="input !h-6 !w-auto" aria-label="Slot a asignar">${slotOptions}</select>
                <button type="button" data-ref="frame-glyph-set" class="btn !h-6">Asignar borrador</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    this.#buildGlyphGrid();
    this.#updatePlayButton();
  }

  #buildLines() {
    const { rows, cols } = this.config;
    this.$('[data-ref=lcd-lines]').innerHTML = Array.from({ length: rows }, (_, i) => {
      const value = this.lcd.lines[i] ?? '';
      return `<div class="grid grid-cols-[3.5rem_minmax(0,1fr)_3rem] items-center gap-2">
        <label class="text-2xs text-slate-400" for="line-${i}">Línea ${i + 1}</label>
        <input id="line-${i}" data-line="${i}" class="input !h-8 font-mono !text-[13px]" maxlength="${cols}" autocomplete="off" spellcheck="false" value="${attr(value)}" />
        <span class="text-right text-2xs tabular-nums text-slate-500" data-counter="${i}">${Array.from(value).length}/${cols}</span></div>`;
    }).join('');
  }

  #buildFrameEditor() {
    const anim = this.animation;
    const frame = anim.frame;
    this.$('[data-ref=frame-strip]').innerHTML = anim.frames
      .map((f, i) => `<button type="button" role="option" data-frame="${i}" aria-selected="${i === anim.selected}" class="btn !h-6 !min-w-[1.75rem] !px-1.5 tabular-nums aria-selected:border-accent/60 aria-selected:bg-accent-soft aria-selected:text-accent-strong">${i + 1}</button>`)
      .join('');
    this.$('[data-frame][aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.$('[data-ref=frame-title]').textContent = `Frame ${anim.selected + 1} de ${anim.frames.length}`;
    this.$('[data-ref=frame-ms]').value = frame.ms;
    this.$('[data-ref=frame-lines]').innerHTML = frame.lines
      .map((line, i) => `<input data-frame-line="${i}" aria-label="Línea ${i + 1} del frame" class="input font-mono" maxlength="${this.config.cols}" autocomplete="off" spellcheck="false" value="${attr(line)}" />`)
      .join('');
    this.#buildFrameGlyphs();
  }

  #buildFrameGlyphs() {
    const slots = Object.keys(this.animation.frame.glyphs);
    this.$('[data-ref=frame-glyphs]').innerHTML = slots.length
      ? slots
          .map((slot) => `<button type="button" data-frame-glyph="${slot}" class="btn !h-6 !gap-1 !px-1.5 font-mono" title="Quitar el glifo ${slot} de este frame">${GLYPH_MARKS[slot]}${icon('close', 'h-3 w-3')}</button>`)
          .join('')
      : '<span class="text-2xs text-slate-600">ninguno</span>';
  }

  #buildGlyphGrid() {
    this.$('[data-ref=glyph-grid]').innerHTML = Array.from({ length: GLYPH_ROWS * GLYPH_COLS }, (_, n) => {
      const row = Math.floor(n / GLYPH_COLS);
      const col = n % GLYPH_COLS;
      return `<button type="button" data-row="${row}" data-col="${col}" aria-pressed="false" aria-label="Fila ${row + 1}, columna ${col + 1}"
        class="aspect-square rounded-[3px] border border-ink-600 bg-ink-950 transition-colors hover:border-accent/60 aria-pressed:border-accent aria-pressed:bg-accent"></button>`;
    }).join('');
    this.$('[data-ref=glyph-slots]').innerHTML = Array.from({ length: GLYPH_SLOTS }, (_, slot) =>
      `<button type="button" class="btn !h-auto flex-col gap-0.5 !px-1 !py-1" data-slot="${slot}" aria-pressed="false" aria-label="Slot ${slot}">
        <canvas width="${GLYPH_COLS}" height="${GLYPH_ROWS}" class="pixelated h-8 w-5 rounded-sm bg-ink-950"></canvas><span class="text-2xs">${slot}</span></button>`,
    ).join('');
  }

  // ------------------------------------------------------------------- eventos

  #bind() {
    const on = (ref, type, handler) => this.$(`[data-ref=${ref}]`).addEventListener(type, handler);

    this.root.querySelectorAll('[data-tab]').forEach((button) =>
      button.addEventListener('click', () => this.#selectTab(button.dataset.tab)),
    );

    // Paleta: inserta en el último campo de texto enfocado.
    this.root.addEventListener('focusin', (e) => {
      if (e.target.matches('[data-line], [data-frame-line]')) this.#lastInput = e.target;
    });
    this.$('[data-ref=palette]').addEventListener('mousedown', (e) => e.preventDefault()); // conserva el foco
    this.$('[data-ref=palette]').addEventListener('click', (e) => {
      const button = e.target.closest('[data-insert]');
      if (button) this.#insert(button.dataset.insert);
    });

    // Texto.
    this.$('[data-ref=lcd-lines]').addEventListener('input', (e) => {
      const input = e.target.closest('[data-line]');
      if (!input) return;
      const index = Number(input.dataset.line);
      input.value = this.lcd.setLine(index, input.value);
      this.$(`[data-counter="${index}"]`).textContent = `${Array.from(input.value).length}/${this.config.cols}`;
      this.deps.onChange();
    });
    on('send-text', 'click', () => this.#guard(() => this.#sendText()));

    // Glifos.
    this.$('[data-ref=glyph-slots]').addEventListener('click', (e) => {
      const button = e.target.closest('[data-slot]');
      if (!button) return;
      this.lcd.selectSlot(Number(button.dataset.slot));
      this.$('[data-ref=place-slot]').value = button.dataset.slot;
      this.#updateGlyphUi();
      this.deps.onChange();
    });
    this.$('[data-ref=glyph-grid]').addEventListener('click', (e) => {
      const cell = e.target.closest('[data-row]');
      if (!cell) return;
      this.lcd.toggleDot(Number(cell.dataset.row), Number(cell.dataset.col));
      this.#updateGlyphUi();
      this.deps.onChange();
    });
    on('glyph-clear', 'click', () => { this.lcd.clearDraft(); this.#updateGlyphUi(); this.deps.onChange(); });
    on('glyph-invert', 'click', () => { this.lcd.invertDraft(); this.#updateGlyphUi(); this.deps.onChange(); });
    on('glyph-save', 'click', () => this.#guard(() => this.#saveGlyph()));
    on('place-send', 'click', () => this.#guard(async () => {
      const command = this.#placeCommand();
      await this.deps.send([command]);
      this.lcd.place(command.slot, command.col, command.row);
      this.deps.onChange();
    }));
    for (const ref of ['place-slot', 'place-col', 'place-row']) on(ref, 'input', () => this.deps.onChange());

    // Animación.
    on('preset', 'change', () => this.#onPresetChange());
    on('preset-go', 'click', () => this.#guard(async () => {
      this.stop();
      const preset = PRESETS.find((p) => p.id === this.$('[data-ref=preset]').value);
      this.animation.generate(preset.id, {
        text: this.$('[data-ref=preset-text]').value,
        row: Number(this.$('[data-ref=preset-row]').value),
      });
      this.#buildFrameEditor();
      this.deps.onChange();
    }));
    on('play', 'click', () => this.#guard(() => this.#togglePlay()));
    on('loop', 'change', (e) => (this.animation.loop = e.target.checked));
    this.$('[data-ref=frame-strip]').addEventListener('click', (e) => {
      const button = e.target.closest('[data-frame]');
      if (!button || this.playing) return;
      this.animation.select(Number(button.dataset.frame));
      this.#buildFrameEditor();
      this.deps.onChange();
    });
    on('frame-add', 'click', () => this.#editFrames(() => this.animation.add()));
    on('frame-dup', 'click', () => this.#editFrames(() => this.animation.duplicate()));
    on('frame-del', 'click', () => this.#editFrames(() => this.animation.remove()));
    on('frame-left', 'click', () => this.#editFrames(() => this.animation.move(-1)));
    on('frame-right', 'click', () => this.#editFrames(() => this.animation.move(1)));
    on('speed', 'change', (e) => (this.speed = Number(e.target.value)));
    on('frame-ms', 'change', (e) => {
      this.animation.frame.ms = Math.max(20, Math.min(10000, Number(e.target.value) || 500));
      e.target.value = this.animation.frame.ms;
    });
    on('ms-all', 'click', () => this.animation.setAllDelays(this.animation.frame.ms));
    this.$('[data-ref=frame-lines]').addEventListener('input', (e) => {
      const input = e.target.closest('[data-frame-line]');
      if (!input) return;
      const text = sanitizeText(input.value, this.config.cols);
      input.value = text;
      this.animation.frame.lines[Number(input.dataset.frameLine)] = text;
      this.deps.onChange();
    });
    on('frame-glyph-set', 'click', () => {
      const slot = Number(this.$('[data-ref=frame-glyph-slot]').value);
      this.animation.frame.glyphs[slot] = [...this.lcd.draft];
      this.#buildFrameGlyphs();
      this.deps.onChange();
    });
    this.$('[data-ref=frame-glyphs]').addEventListener('click', (e) => {
      const button = e.target.closest('[data-frame-glyph]');
      if (!button) return;
      delete this.animation.frame.glyphs[button.dataset.frameGlyph];
      this.#buildFrameGlyphs();
      this.deps.onChange();
    });
  }

  /** Soltar una imagen o SVG convierte el archivo en el carácter personalizado (5x8, blanco y negro). */
  #bindDrop() {
    let depth = 0;
    const highlight = (on) => {
      this.root.classList.toggle('ring-1', on);
      this.root.classList.toggle('ring-inset', on);
      this.root.classList.toggle('ring-accent', on);
    };
    const accepts = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    this.root.addEventListener('dragenter', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      depth++;
      highlight(true);
    });
    this.root.addEventListener('dragover', (e) => accepts(e) && e.preventDefault());
    this.root.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) highlight(false);
    });
    this.root.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      highlight(false);
      const file = [...e.dataTransfer.files].find((f) => fileKind(f));
      if (!file) return this.deps.notify('Suelta una imagen o un SVG: el LCD lo convertirá en un carácter de 5x8 píxeles.');
      try {
        const [first] = await decodeFile(file);
        this.lcd.draft = imageToGlyph(first);
        this.#selectTab('glyph');
        this.#updateGlyphUi();
      } catch (error) {
        this.deps.notify(error.message);
      }
    });
  }

  #selectTab(tab) {
    this.tab = tab;
    this.root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    this.root.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
    this.$('[data-ref=palette]').classList.toggle('hidden', tab === 'glyph'); // clase: [hidden] pierde frente a `flex`
    this.deps.onTab(tab);
    this.deps.onChange();
  }

  #insert(text) {
    const input = this.#lastInput?.isConnected ? this.#lastInput : this.root.querySelector('[data-panel]:not([hidden]) input[data-line], [data-panel]:not([hidden]) input[data-frame-line]');
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.focus();
    input.setSelectionRange(start + text.length, start + text.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  #onPresetChange() {
    const preset = PRESETS.find((p) => p.id === this.$('[data-ref=preset]').value);
    const text = this.$('[data-ref=preset-text]');
    text.disabled = !preset.usesText;
    text.value = preset.usesText ? preset.text : '';
  }

  #editFrames(change) {
    this.stop();
    change();
    this.#buildFrameEditor();
    this.deps.onChange();
  }

  // ------------------------------------------------------------------- acciones

  async #guard(action) {
    try {
      await action();
    } catch (error) {
      this.stop();
      this.deps.notify(error.message);
    }
  }

  async #sendText() {
    await this.deps.send(this.lcd.textCommands());
    this.lcd.markTextSent();
    this.deps.onChange();
  }

  async #saveGlyph() {
    await this.deps.send([this.lcd.glyphCommand()]);
    this.lcd.commitGlyph();
    this.#updateGlyphUi();
    this.deps.onChange();
  }

  #placeCommand() {
    return this.lcd.glyphAtCommand(
      Number(this.$('[data-ref=place-slot]').value),
      Number(this.$('[data-ref=place-col]').value),
      Number(this.$('[data-ref=place-row]').value),
    );
  }

  async #togglePlay() {
    if (this.playing) return this.stop();
    const run = ++this.#run;
    this.playing = true;
    this.#updatePlayButton();
    try {
      do {
        for (let i = 0; i < this.animation.frames.length; i++) {
          if (run !== this.#run) return;
          // El frame en reproducción queda seleccionado: la vista previa y el inspector de bus lo siguen.
          this.animation.select(i);
          this.#buildFrameEditor();
          this.deps.onChange();
          const started = performance.now();
          await this.deps.send(this.animation.compileFrame(i), { quiet: true });
          await this.#wait(this.animation.frames[i].ms / this.speed - (performance.now() - started), run);
        }
      } while (run === this.#run && this.animation.loop);
    } finally {
      if (run === this.#run) this.stop();
    }
  }

  /** Espera interrumpible: se corta en cuanto cambia el token de ejecución. */
  async #wait(ms, run) {
    for (let left = ms; left > 0 && run === this.#run; left -= 50) {
      await sleep(Math.min(50, left));
    }
  }

  // ------------------------------------------------------------------------ UI

  #updatePlayButton() {
    const button = this.$('[data-ref=play]');
    button.innerHTML = this.playing ? `${icon('stop', 'h-3.5 w-3.5')}Detener` : `${icon('play', 'h-3.5 w-3.5')}Reproducir`;
    button.classList.toggle('btn-danger', this.playing);
    button.classList.toggle('btn-accent', !this.playing);
  }

  #updateGlyphUi() {
    this.root.querySelectorAll('[data-row]').forEach((cell) =>
      cell.setAttribute('aria-pressed', String(this.lcd.isDotOn(Number(cell.dataset.row), Number(cell.dataset.col)))),
    );
    this.root.querySelectorAll('[data-slot]').forEach((b) =>
      b.setAttribute('aria-pressed', String(Number(b.dataset.slot) === this.lcd.slot)),
    );
    this.$('[data-ref=glyph-rows]').textContent = `slot ${this.lcd.slot}: [${this.lcd.draft.join(', ')}]`;
    this.#updateThumbs();
  }

  /** Miniaturas de los slots: glifos ya guardados en el LCD. */
  #updateThumbs() {
    this.root.querySelectorAll('[data-slot] canvas').forEach((canvas, slot) => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, GLYPH_COLS, GLYPH_ROWS);
      ctx.fillStyle = '#9dbdff';
      this.lcd.glyphs[slot].forEach((bits, row) => {
        for (let col = 0; col < GLYPH_COLS; col++) {
          if (bits & (1 << (GLYPH_COLS - 1 - col))) ctx.fillRect(col, row, 1, 1);
        }
      });
    });
  }
}
