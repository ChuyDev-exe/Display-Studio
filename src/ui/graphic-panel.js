import { logicalSize } from '../displays/display-configs.js';
import { frameCost } from '../displays/frame-cost.js';
import { DITHER_MODES, dither, fileKind } from '../displays/image-import.js';
import { openAnimationModal } from './animation-modal.js';
import { fileFromClipboard, openDesignImport } from './design-import.js';
import { CanvasEditor } from './canvas-editor.js';
import { icon } from './svg-icons.js';
import { SvgDialog } from './svg-dialog.js';
import { drawStamp, loadImage, normalizeSvg } from './svg-library.js';

const SVG_TEXT = /<svg[\s>]/i;

/**
 * Editor de pantallas gráficas: lienzo, tira de fotogramas con reproducción, colocación de
 * SVG e imágenes (también arrastrando archivos) y acceso al generador de animaciones.
 */
export class GraphicPanel {
  playing = false;
  #run = 0;
  #stamp = null;
  #thumbQueued = false;
  #scratch = document.createElement('canvas');

  /**
   * @param deps.sendFrame(imageData, { quiet })  envía (o simula) un frame completo
   * @param deps.onChange()                        el lienzo o los fotogramas cambiaron
   * @param deps.notify(message)                   error visible para el usuario
   * @param deps.openFigma()                       importar frames de Figma a las pantallas compatibles
   */
  constructor(root, deps) {
    this.root = root;
    this.deps = deps;
    this.root.innerHTML = this.#template();
    this.editor = new CanvasEditor(this.$('[data-ref=canvas]'), {
      onChange: () => {
        this.#queueThumb();
        this.deps.onChange();
      },
      onFramesChange: () => this.#buildStrip(),
    });
    this.dialog = new SvgDialog({
      onPlace: (options) => this.#fromSvg(options).catch((e) => this.deps.notify(e.message)),
    });
    new ResizeObserver(() => this.layout()).observe(this.$('[data-ref=canvas-area]'));
    this.#updatePlayButton();
    this.#bind();
    this.#bindDrop();
  }

  $(selector) {
    return this.root.querySelector(selector);
  }

  // ---------------------------------------------------------------- API pública

  setDisplay(config, rotation) {
    this.stop();
    this.#endStamp();
    this.config = config;
    this.rotation = rotation;
    const { width, height } = logicalSize(config, rotation);
    this.$('[data-ref=canvas-title]').textContent = `${width} x ${height} px`;
    this.$('[data-ref=round-guide]').toggleAttribute('hidden', !config.round); // SVGElement no tiene la propiedad .hidden
    this.editor.setDisplay(config, rotation);
    this.#updateCost();
    this.layout();
  }

  clear() {
    this.stop();
    this.editor.clear();
  }

  stop() {
    this.#run++; // invalida cualquier bucle de reproducción en curso
    if (!this.playing) return;
    this.playing = false;
    this.editor.locked = false;
    this.#updatePlayButton();
  }

  /** Escala el lienzo al espacio libre: entero si hay holgura, para conservar los píxeles. */
  layout() {
    if (!this.config) return;
    const area = this.$('[data-ref=canvas-area]');
    const { width, height } = this.editor.canvas;
    let scale = Math.min((area.clientWidth - 16) / width, (area.clientHeight - 16) / height);
    if (scale >= 2) scale = Math.floor(scale);
    const frame = this.$('[data-ref=canvas-frame]');
    frame.style.width = `${Math.max(1, Math.floor(width * scale))}px`;
    frame.style.height = `${Math.max(1, Math.floor(height * scale))}px`;
  }

  // ------------------------------------------------------------------ plantilla

  #template() {
    const dithers = DITHER_MODES.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
    const iconBtn = (ref, ico, label, extra = '') => `<button type="button" data-ref="${ref}" class="btn btn-ghost btn-icon ${extra}" title="${label}" aria-label="${label}">${icon(ico, 'h-3.5 w-3.5')}</button>`;
    return `
      <section class="relative flex h-full flex-col bg-ink-950" aria-label="Lienzo">
        <div class="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-ink-600 bg-ink-900 px-2">
          <div class="seg" role="group" aria-label="Herramienta de dibujo">
            <button type="button" data-tool="pen" aria-pressed="true" title="Lápiz" aria-label="Lápiz">${icon('pencil', 'h-3.5 w-3.5')}</button>
            <button type="button" data-tool="eraser" aria-pressed="false" title="Borrador" aria-label="Borrador">${icon('eraser', 'h-3.5 w-3.5')}</button>
          </div>
          <label data-ref="color-field" title="Color del lápiz"><span class="sr-only">Color</span><input id="color" data-ref="color" type="color" value="#ffffff" class="swatch block" /></label>
          <div class="flex items-center gap-2 pl-1" title="Grosor del lápiz">
            <label for="brush" class="text-2xs text-slate-500">Grosor</label>
            <input id="brush" data-ref="brush" type="range" min="1" max="16" value="2" class="w-20" />
            <output data-ref="brush-value" for="brush" class="w-8 text-2xs tabular-nums text-slate-400">2 px</output>
          </div>
          <span class="divider-v"></span>
          <button type="button" data-ref="svg-open" class="btn btn-ghost" title="Insertar un SVG de la biblioteca, un archivo o código. También puedes arrastrarlo al lienzo">${icon('image', 'h-3.5 w-3.5')}Insertar SVG</button>
          <button type="button" data-ref="design-open" class="btn btn-ghost" title="Un frame de Figma o una imagen a pantalla completa. También puedes pegarlo con Cmd+V">${icon('layers', 'h-3.5 w-3.5')}Importar diseño</button>
          <button type="button" data-ref="figma-open" class="btn btn-ghost" title="Leer un archivo de Figma y cargar cada frame en las pantallas de su mismo tamaño">${icon('figma', 'h-3.5 w-3.5')}Figma</button>
          <button type="button" data-ref="generate" class="btn btn-ghost" title="Generar fotogramas: efectos, texto, formas o GIF">${icon('wand', 'h-3.5 w-3.5')}Animar</button>
          <span data-ref="canvas-title" class="ml-auto hidden whitespace-nowrap pl-2 text-2xs tabular-nums text-slate-500 md:block"></span>
          <button type="button" data-ref="send-content-main" data-needs-idle class="btn btn-accent ml-auto md:ml-0">${icon('send', 'h-3.5 w-3.5')}Enviar frame</button>
        </div>

        <div data-ref="stamp-bar" hidden>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-accent/30 bg-accent/[.06] px-2 py-1.5 text-xs">
            <span class="flex items-center gap-1.5 pr-1 text-accent-strong">${icon('move', 'h-3.5 w-3.5')}<span>Arrastra el objeto; rueda para escalar</span></span>
            <label data-ref="stamp-color-field" class="flex items-center gap-1.5 text-slate-400" title="Color"><span class="sr-only">Color</span><input data-ref="stamp-color" type="color" value="#ffffff" class="swatch !h-6 !w-6" /></label>
            <label data-ref="stamp-stroke-field" class="flex items-center gap-1.5 text-slate-400">Trazo<input data-ref="stamp-stroke" type="range" min="0.5" max="4" step="0.5" class="w-16" /><output data-ref="stamp-stroke-value" class="w-5 tabular-nums text-slate-300"></output></label>
            <label class="flex items-center gap-1.5 text-slate-400">Tamaño<input data-ref="stamp-size" type="range" min="4" max="240" class="w-24" /><output data-ref="stamp-size-value" class="w-10 tabular-nums text-slate-300"></output></label>
            <button type="button" data-ref="stamp-rotate" class="btn btn-ghost !h-6 !px-1.5" title="Girar 90°">${icon('rotate', 'h-3.5 w-3.5')}90°</button>
            <div data-ref="stamp-crisp-field" class="seg !h-6" role="radiogroup" aria-label="Bordes" title="Nítidos: cada píxel encendido o apagado, sin halos en el panel">
              <button type="button" role="radio" data-crisp="1" aria-checked="true">${icon('sharp', 'h-3 w-3')}Nítido</button>
              <button type="button" role="radio" data-crisp="0" aria-checked="false">${icon('soft', 'h-3 w-3')}Suave</button>
            </div>
            <label data-ref="dither-field" class="flex items-center gap-1.5 text-slate-400">Tramado<select data-ref="stamp-dither" class="input !h-6 !w-auto">${dithers}</select></label>
            <div class="ml-auto flex items-center gap-1">
              <button type="button" data-ref="stamp-cancel" class="btn btn-ghost !h-6">Cancelar</button>
              <button type="button" data-ref="stamp-animate" class="btn !h-6">${icon('wand', 'h-3.5 w-3.5')}Animar</button>
              <button type="button" data-ref="stamp-apply" class="btn btn-accent !h-6">${icon('check', 'h-3.5 w-3.5')}Aplicar</button>
            </div>
          </div>
        </div>

        <div data-ref="canvas-area" class="bench relative flex min-h-0 flex-1 items-center justify-center">
          <div data-ref="canvas-frame" class="relative shadow-[0_0_0_1px_#3a3f47,0_16px_40px_-12px_rgba(0,0,0,0.8)]">
            <canvas data-ref="canvas" class="pixelated draw-surface block h-full w-full bg-black" aria-label="Lienzo de dibujo del display"></canvas>
            <canvas data-ref="stamp-layer" class="pixelated pointer-events-none absolute inset-0 h-full w-full touch-none" aria-hidden="true"></canvas>
            <svg data-ref="round-guide" class="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <circle cx="50" cy="50" r="49.5" fill="none" stroke="#7aa7ff" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
            </svg>
          </div>
        </div>

        <div data-ref="drop-hint" hidden class="pointer-events-none absolute inset-0 z-30 p-2">
          <div class="grid h-full place-items-center rounded-lg border border-dashed border-accent bg-ink-950/85 text-center">
            <div class="space-y-1.5"><span class="mx-auto block w-fit text-accent">${icon('upload', 'h-5 w-5')}</span>
              <p class="text-[13px] font-medium text-white">Suelta para insertar</p>
              <p class="max-w-xs text-xs text-slate-400">Un SVG o una imagen se coloca como objeto. Un GIF o varias imágenes abren el importador de animación.</p></div>
          </div>
        </div>

        <div data-ref="progress" hidden role="progressbar" aria-label="Progreso de envío" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" class="border-t border-ink-600 bg-ink-900">
          <div class="flex items-center gap-3 px-3 py-1.5">
            <div class="h-1 flex-1 overflow-hidden rounded-full bg-ink-700"><div data-ref="progress-bar" class="h-full w-0 bg-accent transition-[width]"></div></div>
            <p data-ref="progress-label" class="text-2xs tabular-nums text-slate-400"></p>
          </div>
        </div>

        <div class="shrink-0 border-t border-ink-600 bg-ink-900">
          <div data-ref="strip" class="flex gap-1.5 overflow-x-auto px-2 pb-1 pt-2" role="listbox" aria-label="Fotogramas"></div>
          <div class="flex flex-wrap items-center gap-1 px-2 pb-1.5 pt-0.5">
            <button type="button" data-ref="play" class="btn btn-icon"></button>
            <label class="btn btn-ghost btn-icon cursor-pointer has-[:checked]:!text-accent has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-accent" title="Repetir en bucle"><input type="checkbox" data-ref="loop" checked class="sr-only" />${icon('repeat', 'h-3.5 w-3.5')}<span class="sr-only">Bucle</span></label>
            <span class="divider-v"></span>
            ${iconBtn('frame-add', 'plus', 'Nuevo fotograma')}
            ${iconBtn('frame-dup', 'copy', 'Duplicar fotograma')}
            ${iconBtn('frame-left', 'chevron-left', 'Mover a la izquierda')}
            ${iconBtn('frame-right', 'chevron-right', 'Mover a la derecha')}
            ${iconBtn('frame-del', 'trash', 'Eliminar fotograma', 'hover:!text-red-300')}
            <span class="divider-v"></span>
            <label class="flex items-center gap-1.5 pl-1 text-2xs text-slate-500">Duración<input data-ref="frame-ms" type="number" min="20" max="10000" step="10" class="input !h-6 !w-16 tabular-nums" aria-label="Duración del fotograma en ms" />ms</label>
            <button type="button" data-ref="ms-all" class="btn btn-ghost !h-6 !px-2 text-2xs">Aplicar a todos</button>
            <span data-ref="cost" class="ml-auto pl-2 text-2xs tabular-nums text-slate-500"></span>
          </div>
        </div>
      </section>`;
  }

  // -------------------------------------------------------------- fotogramas

  #buildStrip() {
    const strip = this.$('[data-ref=strip]');
    const { frames, selected } = this.editor;
    strip.replaceChildren(
      ...frames.map((frame, i) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'option');
        button.dataset.frame = i;
        button.setAttribute('aria-selected', String(i === selected));
        button.className = 'relative shrink-0 overflow-hidden rounded border border-ink-600 bg-black p-0 transition-colors hover:border-ink-500 aria-selected:border-accent aria-selected:shadow-[0_0_0_1px_#7aa7ff]';
        button.setAttribute('aria-label', `Fotograma ${i + 1}`);
        button.innerHTML = `<canvas class="pixelated block h-10 w-auto"></canvas>
          <span class="absolute bottom-0 left-0 rounded-tr bg-ink-950/85 px-1 text-[10px] leading-4 tabular-nums text-slate-300">${i + 1}</span>`;
        this.#paintThumb(button.firstElementChild, i);
        return button;
      }),
    );
    strip.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.$('[data-ref=frame-ms]').value = frames[selected].ms;
    this.$('[data-ref=loop]').checked = this.editor.loop;
  }

  #paintThumb(canvas, index) {
    const image = this.editor.frameImage(index);
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').putImageData(image, 0, 0);
  }

  #queueThumb() {
    if (this.#thumbQueued) return;
    this.#thumbQueued = true;
    requestAnimationFrame(() => {
      this.#thumbQueued = false;
      const canvas = this.$('[data-frame][aria-selected=true] canvas');
      if (canvas) this.#paintThumb(canvas, this.editor.selected);
    });
  }

  #updateCost() {
    const { bytes, ms } = frameCost(this.config, this.rotation);
    const rate = ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
    const cost = this.$('[data-ref=cost]');
    cost.textContent = `${bytes.toLocaleString('es')} B por frame, ${rate}, máx. ${(1000 / ms).toFixed(1)} fps`;
    cost.title = 'Tamaño de cada frame y tiempo aproximado de envío por USB a 921600 baud';
  }

  // ------------------------------------------------------------------- eventos

  #bind() {
    const on = (ref, type, handler) => this.$(`[data-ref=${ref}]`).addEventListener(type, handler);
    const edit = (change) => () => {
      this.stop();
      change();
    };

    this.$('[data-ref=strip]').addEventListener('click', (e) => {
      const button = e.target.closest('[data-frame]');
      if (!button || this.playing) return;
      this.editor.select(Number(button.dataset.frame));
    });
    on('frame-add', 'click', edit(() => this.editor.add()));
    on('frame-dup', 'click', edit(() => this.editor.duplicate()));
    on('frame-del', 'click', edit(() => this.editor.remove()));
    on('frame-left', 'click', edit(() => this.editor.move(-1)));
    on('frame-right', 'click', edit(() => this.editor.move(1)));
    on('frame-ms', 'change', (e) => {
      const ms = Math.max(20, Math.min(10000, Number(e.target.value) || 200));
      this.editor.frames[this.editor.selected].ms = ms;
      e.target.value = ms;
      this.deps.onChange();
    });
    on('ms-all', 'click', () => this.editor.setAllDelays(this.editor.frames[this.editor.selected].ms));
    on('loop', 'change', (e) => {
      this.editor.loop = e.target.checked;
      this.deps.onChange();
    });
    on('play', 'click', () => this.#togglePlay().catch((e) => this.deps.notify(e.message)));
    on('generate', 'click', () => this.openGenerator());
    on('design-open', 'click', () => this.openDesign());
    on('figma-open', 'click', () => {
      this.stop();
      this.#endStamp();
      this.deps.openFigma();
    });

    // Pegar (Cmd+V) un frame copiado en Figma como PNG o SVG abre el importador de diseño.
    document.addEventListener('paste', (e) => {
      if (!this.root.offsetParent || document.querySelector('dialog[open]')) return;
      if (e.target.closest?.('input, textarea, [contenteditable]')) return;
      const file = fileFromClipboard(e);
      if (!file) return;
      e.preventDefault();
      this.openDesign(file);
    });

    on('svg-open', 'click', () => {
      this.#endStamp();
      this.dialog.open({ monochrome: this.config.type === 'mono', ink: this.editor.ink });
    });
    on('stamp-size', 'input', (e) => this.#setStampSize(Number(e.target.value)));
    on('stamp-color', 'input', (e) => this.#restyleStamp({ color: e.target.value }));
    on('stamp-stroke', 'input', (e) => {
      this.$('[data-ref=stamp-stroke-value]').textContent = e.target.value;
      this.#restyleStamp({ strokeWidth: Number(e.target.value) });
    });
    on('stamp-rotate', 'click', () => {
      this.#stamp.angle += Math.PI / 2;
      this.#drawStamp();
    });
    on('stamp-dither', 'change', (e) => {
      this.#stamp.dither = e.target.value;
      this.#drawStamp();
    });
    on('stamp-crisp-field', 'click', (e) => {
      const button = e.target.closest('[data-crisp]');
      if (!button || !this.#stamp) return;
      this.#stamp.crisp = button.dataset.crisp === '1';
      this.#syncCrisp();
      this.#drawStamp();
    });
    on('stamp-apply', 'click', () => this.#applyStamp());
    on('stamp-animate', 'click', () => this.openGenerator({ initial: 'object' }));
    on('stamp-cancel', 'click', () => this.#endStamp());

    // Arrastrar el objeto sobre la capa de colocación.
    const layer = this.$('[data-ref=stamp-layer]');
    let drag = null;
    const pixel = (e) => {
      const rect = layer.getBoundingClientRect();
      return { x: ((e.clientX - rect.left) * layer.width) / rect.width, y: ((e.clientY - rect.top) * layer.height) / rect.height };
    };
    layer.addEventListener('pointerdown', (e) => {
      if (!this.#stamp) return;
      layer.setPointerCapture(e.pointerId);
      const p = pixel(e);
      drag = { dx: this.#stamp.cx - p.x, dy: this.#stamp.cy - p.y };
    });
    layer.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = pixel(e);
      this.#stamp.cx = p.x + drag.dx;
      this.#stamp.cy = p.y + drag.dy;
      this.#drawStamp();
    });
    layer.addEventListener('pointerup', () => (drag = null));
    layer.addEventListener('pointercancel', () => (drag = null));
    layer.addEventListener('wheel', (e) => {
      if (!this.#stamp) return;
      e.preventDefault();
      this.#setStampSize(this.#stamp.size * (e.deltaY < 0 ? 1.08 : 0.92));
    }, { passive: false });
  }

  // -------------------------------------------------------- arrastrar y soltar

  #bindDrop() {
    const hint = this.$('[data-ref=drop-hint]');
    let depth = 0;
    const accepts = (e) => [...(e.dataTransfer?.types ?? [])].some((t) => t === 'Files' || t === 'text/plain');

    this.root.addEventListener('dragenter', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      depth++;
      hint.hidden = false;
    });
    this.root.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    this.root.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) hint.hidden = true;
    });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      hint.hidden = true;
      this.#handleDrop(e.dataTransfer).catch((error) => this.deps.notify(error.message));
    });
  }

  async #handleDrop(transfer) {
    const files = [...transfer.files];
    if (!files.length) {
      const text = transfer.getData('text/plain');
      if (SVG_TEXT.test(text)) await this.#fromSvg({ raw: text, name: 'SVG soltado', color: this.editor.ink, strokeWidth: null });
      return;
    }
    const supported = files.filter((f) => fileKind(f));
    if (supported.length < files.length) {
      this.deps.notify(`Se omitieron ${files.length - supported.length} archivo(s) que no son imágenes compatibles.`);
    }
    if (!supported.length) return;

    const kind = fileKind(supported[0]);
    if (supported.length > 1 || kind === 'gif') return this.openGenerator({ files: supported });
    if (kind === 'svg') return this.#fromSvg({ raw: await supported[0].text(), name: supported[0].name, color: this.editor.ink, strokeWidth: null });
    const bitmap = await createImageBitmap(supported[0]);
    return this.#startStamp({ image: bitmap, ratio: bitmap.width / bitmap.height, name: supported[0].name, dither: 'floyd' });
  }

  // ------------------------------------------------------------ SVG e imágenes

  async #fromSvg({ raw, name, color, strokeWidth }) {
    const { svg, ratio } = normalizeSvg(raw, { color, strokeWidth });
    const style = { raw, color, strokeWidth: strokeWidth ?? 2, hasStroke: /stroke=/.test(raw.slice(0, 600)) };
    return this.#startStamp({ image: await loadImage(svg), ratio, name, dither: 'threshold', style });
  }

  /** Vuelve a rasterizar el SVG con otro color o grosor sin perder posición, tamaño ni giro. */
  async #restyleStamp(patch) {
    const stamp = this.#stamp;
    if (!stamp?.style) return;
    Object.assign(stamp.style, patch);
    const token = (stamp.restyle = (stamp.restyle ?? 0) + 1);
    try {
      const { svg, ratio } = normalizeSvg(stamp.style.raw, { color: stamp.style.color, strokeWidth: stamp.style.strokeWidth });
      const image = await loadImage(svg);
      if (this.#stamp !== stamp || token !== stamp.restyle) return; // llegó tarde: hay un cambio más reciente
      Object.assign(stamp, { image, ratio });
      this.#drawStamp();
    } catch (error) {
      this.deps.notify(error.message);
    }
  }

  async #startStamp({ image, ratio, name, dither: mode, style = null }) {
    this.stop();
    const { width, height } = this.editor.canvas;
    // Los SVG van con bordes nítidos por defecto; las fotos conservan su suavizado.
    this.#stamp = { name, image, ratio, dither: mode, style, crisp: Boolean(style), cx: width / 2, cy: height / 2, size: Math.round(Math.min(width, height) * 0.6), angle: 0 };
    const slider = this.$('[data-ref=stamp-size]');
    slider.max = String(Math.round(Math.max(width, height) * 1.5));
    const mono = this.config.type === 'mono';
    this.$('[data-ref=dither-field]').classList.toggle('hidden', !mono); // clase: [hidden] pierde frente a `flex`
    this.$('[data-ref=stamp-dither]').value = mode;
    this.$('[data-ref=stamp-crisp-field]').classList.toggle('hidden', mono); // en mono decide el tramado
    this.#syncCrisp();
    this.$('[data-ref=stamp-color-field]').classList.toggle('hidden', mono || !style);
    this.$('[data-ref=stamp-stroke-field]').classList.toggle('hidden', !style?.hasStroke);
    if (style) {
      this.$('[data-ref=stamp-color]').value = style.color;
      this.$('[data-ref=stamp-stroke]').value = String(style.strokeWidth);
      this.$('[data-ref=stamp-stroke-value]').textContent = String(style.strokeWidth);
    }
    this.#scratch.width = width;
    this.#scratch.height = height;
    const layer = this.$('[data-ref=stamp-layer]');
    layer.width = width;
    layer.height = height;
    layer.classList.remove('pointer-events-none');
    layer.classList.add('cursor-move');
    this.$('[data-ref=stamp-bar]').hidden = false;
    this.layout();
    this.#setStampSize(this.#stamp.size);
  }

  #syncCrisp() {
    this.$('[data-ref=stamp-crisp-field]').querySelectorAll('[data-crisp]').forEach((b) =>
      b.setAttribute('aria-checked', String((b.dataset.crisp === '1') === this.#stamp.crisp)));
  }

  #setStampSize(size) {
    const slider = this.$('[data-ref=stamp-size]');
    this.#stamp.size = Math.max(4, Math.min(Number(slider.max), Math.round(size)));
    slider.value = String(this.#stamp.size);
    this.$('[data-ref=stamp-size-value]').textContent = `${this.#stamp.size}px`;
    this.#drawStamp();
  }

  /** Dibuja el objeto en `ctx`; en pantallas mono lo reduce a 1 bit con el tramado elegido. */
  #renderStamp(ctx, input) {
    const { image, ratio, dither: mode, crisp } = this.#stamp;
    const params = { crisp, ...input };
    if (this.config.type !== 'mono' || mode === 'threshold') return drawStamp(ctx, image, ratio, params);
    const scratch = this.#scratch.getContext('2d', { willReadFrequently: true });
    scratch.clearRect(0, 0, this.#scratch.width, this.#scratch.height);
    drawStamp(scratch, image, ratio, params);
    scratch.putImageData(dither(scratch.getImageData(0, 0, this.#scratch.width, this.#scratch.height), mode, 128, true), 0, 0);
    ctx.drawImage(this.#scratch, 0, 0);
  }

  #drawStamp() {
    const layer = this.$('[data-ref=stamp-layer]');
    const ctx = layer.getContext('2d');
    ctx.clearRect(0, 0, layer.width, layer.height);
    if (!this.#stamp) return;
    const { cx, cy, size, angle } = this.#stamp;
    this.#renderStamp(ctx, { cx, cy, size, angle });
  }

  #endStamp() {
    this.#stamp = null;
    const layer = this.$('[data-ref=stamp-layer]');
    layer.getContext('2d').clearRect(0, 0, layer.width, layer.height);
    layer.classList.add('pointer-events-none');
    layer.classList.remove('cursor-move');
    this.$('[data-ref=stamp-bar]').hidden = true;
    this.layout();
  }

  #applyStamp() {
    const { cx, cy, size, angle, name } = this.#stamp;
    const params = { cx, cy, size, angle };
    this.editor.paint((ctx) => this.#renderStamp(ctx, params));
    const object = this.#captureObject(name, params);
    if (object) this.editor.addObject(object);
    this.#endStamp();
    this.deps.onChange();
  }

  /** Renderiza el objeto solo, sobre transparente, y lo recorta a su caja: es el bitmap que iría al firmware. */
  #captureObject(name, params) {
    const { width, height } = this.editor.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.#renderStamp(ctx, params);
    const { data } = ctx.getImageData(0, 0, width, height);
    let [x0, y0, x1, y1] = [width, height, -1, -1];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] < 16) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0) return null; // quedó fuera del lienzo
    return { name, x: x0, y: y0, image: ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1) };
  }

  // ------------------------------------------------------------------ diseño

  openDesign(file = null) {
    this.stop();
    this.#endStamp();
    openDesignImport({
      config: this.config,
      rotation: this.rotation,
      file,
      notify: this.deps.notify,
      onApply: (image, mode) => this.applyDesign(image, mode),
    });
  }

  /** Coloca un diseño ya ajustado al tamaño lógico: en el fotograma actual o como uno nuevo. */
  applyDesign(image, mode = 'replace') {
    const { width, height } = this.editor.canvas;
    if (image.width !== width || image.height !== height) return this.deps.notify('El diseño no coincide con el tamaño del lienzo; vuelve a importarlo.');
    this.stop();
    if (mode === 'append') return this.editor.appendFrames([{ data: image, ms: this.editor.frames[this.editor.selected].ms }]);
    this.editor.clear();
    this.editor.paint((ctx) => ctx.putImageData(image, 0, 0));
  }

  // --------------------------------------------------------------- generador

  openGenerator({ files = [], initial } = {}) {
    this.stop();
    const stamp = this.#stamp
      ? {
          params: { cx: this.#stamp.cx, cy: this.#stamp.cy, size: this.#stamp.size, angle: this.#stamp.angle, crisp: this.#stamp.crisp },
          render: (ctx, params) => this.#renderStamp(ctx, params),
        }
      : null;
    openAnimationModal({
      config: this.config,
      rotation: this.rotation,
      base: () => this.editor.getImageData(),
      stamp,
      files,
      initial,
      onApply: (items, mode) => {
        this.#endStamp();
        if (mode === 'append') this.editor.appendFrames(items);
        else this.editor.setFrames(items);
      },
    });
  }

  // -------------------------------------------------------------- reproducción

  #updatePlayButton() {
    const button = this.$('[data-ref=play]');
    button.innerHTML = icon(this.playing ? 'stop' : 'play', 'h-3.5 w-3.5');
    button.title = this.playing ? 'Detener' : 'Reproducir en la pantalla';
    button.setAttribute('aria-label', button.title);
    button.classList.toggle('btn-danger', this.playing);
    button.classList.toggle('btn-accent', !this.playing);
  }

  async #togglePlay() {
    if (this.playing) return this.stop();
    this.#endStamp();
    const run = ++this.#run;
    this.playing = true;
    this.editor.locked = true;
    this.#updatePlayButton();
    try {
      do {
        for (let i = 0; i < this.editor.frames.length; i++) {
          if (run !== this.#run) return;
          this.editor.select(i);
          const started = performance.now();
          await this.deps.sendFrame(this.editor.getImageData(), { quiet: true });
          await this.#wait(this.editor.frames[i].ms - (performance.now() - started), run);
        }
      } while (run === this.#run && this.editor.loop);
    } finally {
      if (run === this.#run) this.stop();
    }
  }

  /** Espera interrumpible: se corta en cuanto cambia el token de ejecución. */
  async #wait(ms, run) {
    for (let left = ms; left > 0 && run === this.#run; left -= 50) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, left)));
    }
  }
}
