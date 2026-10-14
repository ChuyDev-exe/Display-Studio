import { BusView } from './bus-view.js';
import { CodeView } from './code-view.js';
import { GraphicPanel } from './graphic-panel.js';
import { LcdPanel } from './lcd-panel.js';
import { icon, logo } from './svg-icons.js';
import { openDisplayPicker } from './display-picker.js';
import { confirmModal } from './modal.js';
import { StatusView } from './status-view.js';
import { busTransactions } from '../displays/bus-encoder.js';
import {
  DEFAULT_DISPLAY, DISPLAYS, DISPLAY_ORDER, ROTATIONS, defaultClock, formatLabel, logicalSize, removeDisplay, resolutionLabel,
} from '../displays/display-configs.js';
import { loadCustomDisplays, saveCustomDisplays } from '../displays/custom-displays.js';
import { openDisplayModal } from './display-modal.js';
import { openFigmaImport } from './figma-import.js';
import { openBrowserCheck } from './browser-check.js';
import { touchLabel } from '../displays/display-catalog.js';
import { LcdAnimation } from '../displays/lcd-animation.js';
import { LcdEditor } from '../displays/lcd-editor.js';
import {
  decodeMono1bpp, decodeRgb565LE, rgbaToMono1bpp, rgbaToRgb565LE,
} from '../displays/pixel-encoder.js';
import { nativePreview } from '../displays/native-format.js';
import { CHUNK_SIZE, PIXEL_FORMAT, buildFrameHeader, chunkPayload, commands } from '../serial/protocol.js';
import { BAUD_RATE, SerialManager } from '../serial/serial-manager.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hexBytes = (bytes) => Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

const TAB_SOURCE = { text: 'content', glyph: 'glyph', anim: 'anim' };
const LCD_SOURCES = [
  { id: 'content', label: 'Texto actual' },
  { id: 'glyph', label: 'Guardar carácter' },
  { id: 'place', label: 'Colocar carácter' },
  { id: 'anim', label: 'Frame de animación' },
  { id: 'config', label: 'Configuración' },
];
const GRAPHIC_SOURCES = [
  { id: 'content', label: 'Frame completo' },
  { id: 'config', label: 'Configuración' },
];

export class App {
  displayKey = DEFAULT_DISPLAY;
  source = 'content';
  busy = false;
  #refreshQueued = false;
  #quietLogged = false;
  #payload = null;
  #scratch = null;
  #settings = new Map();

  constructor(root) {
    this.root = root;
    this.serial = new SerialManager();
    this.lcd = new LcdEditor();
    this.animation = new LcdAnimation();
  }

  get config() {
    return DISPLAYS[this.displayKey];
  }

  get prefs() {
    return this.#prefsFor(this.displayKey);
  }

  /** Preferencias por pantalla, creadas al primer uso (así valen también las pantallas propias). */
  #prefsFor(key) {
    if (!this.#settings.has(key)) {
      const d = DISPLAYS[key];
      this.#settings.set(key, {
        brightness: 70, rotation: 0, bus: d.defaultBus, addr: d.i2cAddr ?? 0x3c,
        clock: defaultClock(d, d.defaultBus), includeInit: false,
      });
    }
    return this.#settings.get(key);
  }

  $(selector) {
    return this.root.querySelector(selector);
  }

  init() {
    loadCustomDisplays();
    this.root.innerHTML = this.#template();
    this.graphic = new GraphicPanel(this.$('[data-ref=graphic-root]'), {
      sendFrame: (image, opts) => this.sendFrame(image, opts),
      onChange: () => this.#scheduleRefresh(),
      notify: (message) => {
        this.status.log('err', message);
        this.status.notice('error', message, 'action-error');
      },
      openFigma: () => this.openFigma(),
    });
    this.editor = this.graphic.editor;
    this.status = new StatusView({
      badge: this.$('[data-ref=badge]'),
      notices: this.$('[data-ref=notices]'),
      log: this.$('[data-ref=console]'),
      progress: {
        root: this.$('[data-ref=progress]'),
        bar: this.$('[data-ref=progress-bar]'),
        label: this.$('[data-ref=progress-label]'),
      },
    });
    this.bus = new BusView(this.$('[data-ref=bus-root]'), {
      onChange: (patch) => this.#onBusChange(patch),
      onCopyError: (error) => this.status.notice('error', `No se pudo copiar: ${error.message}`, 'copy'),
    });
    this.codeView = new CodeView(this.$('[data-ref=code-root]'), {
      getState: () => this.#codeState(),
      notify: (message) => this.status.notice('error', message, 'action-error'),
    });
    this.lcdPanel = new LcdPanel(this.$('[data-ref=lcd-root]'), {
      lcd: this.lcd,
      animation: this.animation,
      previewCanvas: this.$('[data-ref=lcd-preview]'),
      send: (cmds, opts) => this.dispatchCommands(cmds, opts),
      onChange: () => this.#scheduleRefresh(),
      onTab: (tab) => {
        this.source = TAB_SOURCE[tab];
        this.#setInspectorContext();
      },
      notify: (message) => {
        this.status.log('err', message);
        this.status.notice('error', message, 'action-error');
      },
    });

    this.#bindEvents();
    this.#bindDock();
    new ResizeObserver(() => this.#layoutCanvases()).observe(this.$('[data-ref=preview-box]'));
    new ResizeObserver(() => this.#layoutLcdPreview()).observe(this.$('[data-ref=preview-lcd]'));

    if (SerialManager.supported) {
      this.status.setConnection('disconnected');
    } else {
      this.status.setConnection('unsupported');
      this.status.notice(
        'warn',
        'Este navegador no soporta Web Serial. Usa Chrome, Edge u Opera de escritorio, desde localhost o HTTPS. La interfaz funciona en modo simulación.',
        'unsupported',
      );
      this.$('[data-ref=connect]').disabled = true;
    }
    this.status.log('sys', 'Sin ESP32 conectado: los envíos se simulan localmente.');
    this.selectDisplay(DEFAULT_DISPLAY, { send: false });
    openBrowserCheck({ auto: true });
  }

  // ---------------------------------------------------------------- selección

  selectDisplay(key, { send = true } = {}) {
    this.lcdPanel.stop();
    this.graphic.stop();
    this.displayKey = key;
    const config = this.config;
    const graphic = config.mode === 'graphic';

    this.$('[data-ref=display-name]').textContent = config.label;
    this.$('[data-ref=display-meta]').textContent = config.mode === 'character' ? `${config.cols} x ${config.rows}` : `${config.width} x ${config.height}`;
    for (const [ref, show] of [
      ['graphic-panel', graphic], ['lcd-panel', !graphic],
      ['preview-graphic', graphic], ['preview-lcd', !graphic],
    ]) this.$(`[data-ref=${ref}]`).hidden = !show;
    const clear = this.$('[data-ref=clear-content]');
    clear.title = graphic ? 'Limpiar lienzo' : 'Limpiar LCD';
    clear.setAttribute('aria-label', clear.title);

    const { brightness, rotation } = this.prefs;
    this.$('[data-ref=brightness]').value = brightness;
    this.$('[data-ref=brightness-value]').textContent = `${brightness}%`;
    this.#setRotationUi(rotation);
    this.$('[data-ref=rotation]').title = graphic ? '' : 'En un LCD de caracteres describe cómo está montado el módulo (solo la vista previa)';
    this.$('[data-ref=prop-summary]').innerHTML = [
      ['Resolución', resolutionLabel(config)], ['Formato', formatLabel(config)], ['ID de firmware', config.id],
      ...(config.touch ? [['Táctil', touchLabel(config.touch)]] : []),
    ].map(([k, v]) => `<div class="flex justify-between gap-3"><dt class="text-slate-500">${k}</dt><dd class="truncate text-right tabular-nums text-slate-300">${v}</dd></div>`).join('');

    if (graphic) {
      this.$('[data-ref=color-field]').hidden = config.type === 'mono';
      this.graphic.setDisplay(config, rotation);
      this.source = 'content';
    } else {
      this.lcdPanel.setDisplay(config);
      this.source = TAB_SOURCE[this.lcdPanel.tab];
    }

    this.#setInspectorContext();
    this.#layoutCanvases();
    this.status.setProgress(0, 0);
    this.#scheduleRefresh();
    if (send) this.#run(() => this.sendConfig());
  }

  // ------------------------------------------------------------------- Figma

  /** Carga frames de Figma en los documentos de cada pantalla compatible, sin cambiar la activa. */
  openFigma() {
    const notify = (message) => this.status.log('err', message);
    openFigmaImport({
      displays: DISPLAY_ORDER.map((key) => DISPLAYS[key]).filter((d) => d.mode === 'graphic'),
      notify,
      onApply: (groups, mode) => {
        for (const { config, rotation, items } of groups) {
          this.editor.importFrames(config, rotation, items, mode);
          this.status.log('sys', `Figma: ${items.length} fotograma${items.length === 1 ? '' : 's'} en ${config.label}${rotation ? ' (girada 90°)' : ''}.`);
        }
        this.#scheduleRefresh();
      },
      onOpen: (key, rotation) => {
        // Los frames girados viven en el documento vertical/horizontal: se abre esa orientación.
        const changed = rotation !== this.#prefsFor(key).rotation % 2;
        if (changed) this.#prefsFor(key).rotation = rotation;
        if (key !== this.displayKey || changed) this.selectDisplay(key);
      },
    });
  }

  // ------------------------------------------------------------------ envíos

  /** Envía un comando JSON al ESP32, o lo simula si no hay conexión. `quiet` omite el registro (animaciones). */
  async dispatchJson(command, { quiet = false } = {}) {
    const text = JSON.stringify(command);
    const connected = this.serial.connected;
    if (connected) await this.serial.sendJson(command);
    else await sleep(quiet ? 5 : 60);

    if (!quiet) {
      this.#quietLogged = false;
      this.status.log(connected ? 'tx' : 'sim', connected ? text : `-> ${text}`);
      if (!connected) this.status.log('sim', `<- OK ${command.cmd}${command.display ? ` ${command.display}` : ''}`);
    } else if (!this.#quietLogged) {
      this.#quietLogged = true;
      this.status.log('sys', 'Reproduciendo animación: se omiten los mensajes TX y OK repetidos.');
    }
  }

  async dispatchCommands(list, options) {
    for (const command of list) await this.dispatchJson(command, options);
  }

  sendConfig() {
    const { brightness, rotation } = this.prefs;
    return this.dispatchJson(commands.config(this.displayKey, brightness, rotation));
  }

  /** Envía un frame (o lo simula). `quiet` omite el registro por frame durante las animaciones. */
  async sendFrame(image = this.editor.getImageData(), { quiet = false } = {}) {
    const config = this.config;
    const { width, height } = image;
    const payload = this.#encodeFrame(image);
    const header = buildFrameHeader({ displayId: config.id, width, height, format: config.format, payload });
    const onProgress = (sent, total) => this.status.setProgress(sent, total);
    const summary = `${config.label} ${width}x${height} (${payload.length.toLocaleString('es')} B)`;

    if (this.serial.connected) {
      await this.serial.sendFrame(header, payload, { onProgress });
      if (!quiet) this.status.log('tx', `frame ${summary}, CRC en cabecera`);
    } else {
      // Simulación: mismos bloques de 1024 bytes y el tiempo que tardaría el USB a 921600 baud.
      if (!quiet) this.status.log('sim', `-> frame ${summary} en bloques de ${CHUNK_SIZE}`);
      let sent = 0;
      onProgress(0, payload.length);
      for (const block of chunkPayload(payload)) {
        await sleep((block.length * 10 * 1000) / BAUD_RATE);
        sent += block.length;
        onProgress(sent, payload.length);
      }
      if (!quiet) this.status.log('sim', '<- OK frame');
    }
    if (quiet && !this.#quietLogged) {
      this.#quietLogged = true;
      this.status.log('sys', 'Reproduciendo animación: se omiten los mensajes TX y OK repetidos.');
    } else if (!quiet) this.#quietLogged = false;
  }

  sendContent() {
    return this.config.mode === 'graphic' ? this.sendFrame() : this.lcdPanel.sendCurrent();
  }

  clearContent() {
    if (this.config.mode === 'graphic') this.graphic.clear();
    else this.lcdPanel.clear();
  }

  #encodeFrame(image = this.editor.getImageData()) {
    const config = this.config;
    return config.format === PIXEL_FORMAT.RGB565_LE ? rgbaToRgb565LE(image) : rgbaToMono1bpp(image);
  }

  /** Ejecuta una acción mostrando cualquier error como aviso en pantalla. */
  async #run(action) {
    if (this.busy) return;
    this.#setBusy(true);
    try {
      await action();
    } catch (error) {
      this.status.log('err', error.message);
      this.status.notice('error', error.message, 'action-error');
    } finally {
      this.#setBusy(false);
    }
  }

  #setBusy(busy) {
    this.busy = busy;
    this.root.querySelectorAll('[data-needs-idle]').forEach((el) => (el.disabled = busy));
  }

  async #toggleConnection() {
    this.status.dismissNotice('action-error');
    try {
      if (this.serial.connected) {
        await this.serial.disconnect();
      } else if (await this.serial.connect()) {
        await this.#run(() => this.sendConfig()); // sincroniza el ESP32 con la UI
      }
    } catch (error) {
      this.status.log('err', error.message);
      this.status.notice('error', `No se pudo abrir el puerto: ${error.message}`, 'action-error');
    }
  }

  // ----------------------------------------------- vista previa e inspector

  #scheduleRefresh() {
    if (this.#refreshQueued) return;
    this.#refreshQueued = true;
    requestAnimationFrame(() => {
      this.#refreshQueued = false;
      this.#renderPreview();
      this.#renderInspector();
      this.codeView.schedule();
    });
  }

  /** Estado que necesita el generador de código (ver code-export.js). */
  #codeState() {
    const state = { config: this.config, prefs: this.prefs, lcd: this.lcd };
    if (this.config.mode === 'graphic') {
      state.frames = this.editor.frames.map((frame, i) => ({ image: this.editor.frameImage(i), ms: frame.ms }));
      state.loop = this.editor.loop;
      state.objects = this.editor.objects;
    }
    return state;
  }

  #renderPreview() {
    const config = this.config;
    if (config.mode === 'character') {
      this.lcdPanel.renderPreview();
      this.#layoutLcdPreview();
      const { rotation } = this.prefs;
      this.$('[data-ref=rotation-note]').textContent = rotation
        ? `Módulo montado girado ${rotation * 90}° en sentido horario. Es solo la vista previa: el HD44780 no gira por hardware.`
        : 'Módulo montado sin rotación.';
      return;
    }
    // La vista previa decodifica el payload real y lo muestra como se vería en el panel físico:
    // el lienzo es lógico (ya rotado) y el panel gira esa imagen según la rotación elegida.
    const { rotation } = this.prefs;
    const { width: lw, height: lh } = logicalSize(config, rotation);
    this.#payload = this.#encodeFrame();
    // Con protocolo propio se cuantiza al formato nativo del chip (grises, RGB332, tinta de e-paper...).
    const decoded = config.profile
      ? nativePreview(this.editor.getImageData(), config.profile.pixel, { on: config.previewOn, off: config.previewOff })
      : config.format === PIXEL_FORMAT.RGB565_LE
        ? decodeRgb565LE(this.#payload, lw, lh)
        : decodeMono1bpp(this.#payload, lw, lh, config.previewOn, config.previewOff);

    this.#scratch ??= document.createElement('canvas');
    this.#scratch.width = lw;
    this.#scratch.height = lh;
    this.#scratch.getContext('2d').putImageData(decoded, 0, 0);

    const preview = this.$('[data-ref=preview-canvas]');
    const pad = 10; // margen para el conector, que queda fijo en el borde inferior nativo del panel
    const { width: w, height: h } = config;
    preview.width = w + pad * 2;
    preview.height = h + pad * 2;
    const ctx = preview.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const outline = () => {
      ctx.beginPath();
      if (config.round) ctx.ellipse(pad + w / 2, pad + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(pad, pad, w, h);
    };
    ctx.save();
    outline();
    ctx.clip();
    ctx.translate(pad + w / 2, pad + h / 2);
    ctx.rotate((rotation * Math.PI) / 2);
    ctx.drawImage(this.#scratch, -lw / 2, -lh / 2);
    ctx.restore();
    ctx.strokeStyle = '#3a3f47';
    ctx.lineWidth = 2;
    outline();
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(pad + w / 2 - Math.max(6, w * 0.08), pad + h, Math.max(12, w * 0.16), pad - 2);
    this.#layoutCanvases();
    this.$('[data-ref=rotation-note]').textContent = rotation
      ? `Vista del panel físico: la imagen gira ${rotation * 90}° en sentido horario respecto al conector (barra ámbar, fija).`
      : 'Vista del panel físico sin rotación. La barra ámbar marca el conector.';
  }

  #renderInspector() {
    const config = this.config;
    const { bus, addr, clock, includeInit, brightness, rotation } = this.prefs;
    let usb;
    let work;

    if (this.source === 'config') {
      const command = commands.config(this.displayKey, brightness, rotation);
      usb = [JSON.stringify(command)];
      work = { type: 'config', brightness, rotation };
    } else if (config.mode === 'graphic') {
      const payload = this.#payload ?? this.#encodeFrame();
      const { width, height } = logicalSize(config, rotation);
      const header = buildFrameHeader({ displayId: config.id, width, height, format: config.format, payload });
      const blocks = Math.ceil(payload.length / CHUNK_SIZE);
      usb = [
        `cabecera (17 B): ${hexBytes(header)}`,
        `payload: ${payload.length.toLocaleString('es')} B en ${blocks} bloques de ${CHUNK_SIZE} B`,
        `${width} x ${height} px, formato ${config.format === PIXEL_FORMAT.RGB565_LE ? 'RGB565 little-endian' : '1 bit por píxel'}, display ID ${config.id}${this.graphic.editor.frames.length > 1 ? ` · frame ${this.graphic.editor.selected + 1}/${this.graphic.editor.frames.length}` : ''}`,
      ];
      work = { type: 'frame', payload, width, height, rotation, image: config.profile ? this.editor.getImageData() : null };
    } else {
      const list = this.lcdPanel.commandsFor(this.source);
      usb = list.length ? list.map((c) => JSON.stringify(c)) : ['(sin comandos)'];
      work = { type: 'lcd', commands: list };
    }

    const result = busTransactions(config, bus, { addr, clock, includeInit, brightness }, work);
    this.bus.show({ usb, rows: result.rows, summary: result.summary });
  }

  #setInspectorContext() {
    const sources = this.config.mode === 'graphic' ? GRAPHIC_SOURCES : LCD_SOURCES;
    if (!sources.some((s) => s.id === this.source)) this.source = 'content';
    this.bus.setContext(this.config, { source: this.source, ...this.prefs }, sources);
  }

  #onBusChange(patch) {
    const { source, ...prefs } = patch;
    if (source) this.source = source;
    Object.assign(this.prefs, prefs);
    if (prefs.bus) this.prefs.clock = defaultClock(this.config, prefs.bus) || this.prefs.clock;
    this.#setInspectorContext();
    this.#scheduleRefresh();
  }

  /** Escala la vista previa (gráfica o LCD) al recuadro disponible; el lienzo principal lo escala GraphicPanel. */
  #layoutCanvases() {
    const config = this.config;
    if (!config) return;
    if (config.mode === 'character') return this.#layoutLcdPreview();
    const box = this.$('[data-ref=preview-box]');
    const preview = this.$('[data-ref=preview-canvas]');
    if (!preview.width) return;
    const scale = Math.min((box.clientWidth - 8) / preview.width, (box.clientHeight - 8) / preview.height);
    preview.style.width = `${Math.max(1, Math.floor(preview.width * scale))}px`;
    preview.style.height = `${Math.max(1, Math.floor(preview.height * scale))}px`;
  }

  /** El LCD se gira con CSS: los giros de 90° necesitan una caja cuadrada y el módulo escalado para caber. */
  #layoutLcdPreview() {
    const canvas = this.$('[data-ref=lcd-preview]');
    const box = this.$('[data-ref=lcd-box]');
    const available = this.$('[data-ref=preview-lcd]').clientWidth - 16;
    if (!canvas.width || available <= 0) return;
    const { rotation } = this.prefs;
    let scale;
    if (rotation % 2) {
      box.style.height = '11rem';
      scale = Math.min(available / canvas.height, (176 - 16) / canvas.width);
    } else {
      box.style.height = '';
      scale = available / canvas.width;
    }
    canvas.style.width = `${canvas.width * scale}px`;
    canvas.style.height = `${canvas.height * scale}px`;
    canvas.style.transform = rotation ? `rotate(${rotation * 90}deg)` : '';
  }

  // ----------------------------------------------------------------- eventos

  #bindEvents() {
    const on = (ref, type, handler) => this.$(`[data-ref=${ref}]`).addEventListener(type, handler);

    on('connect', 'click', () => this.#toggleConnection());
    on('send-config', 'click', () => this.#run(() => this.sendConfig()));
    on('send-content', 'click', () => this.#run(() => this.sendContent()));
    on('send-content-main', 'click', () => this.#run(() => this.sendContent()));
    on('clear-content', 'click', () => this.clearContent());
    on('clear-console', 'click', () => this.status.clearLog());
    on('display-pick', 'click', () => this.#openPicker());
    on('browser-info', 'click', () => openBrowserCheck());

    // Pestañas del dock inferior: bus / consola.
    this.root.querySelectorAll('[data-dock]').forEach((button) =>
      button.addEventListener('click', () => {
        this.root.querySelectorAll('[data-dock]').forEach((b) => b.setAttribute('aria-selected', String(b === button)));
        this.root.querySelectorAll('[data-dock-panel]').forEach((p) => (p.hidden = p.dataset.dockPanel !== button.dataset.dock));
        this.$('[data-ref=clear-console]').classList.toggle('hidden', button.dataset.dock !== 'console');
        this.#setDockCollapsed(false);
        if (button.dataset.dock === 'code') this.codeView.show();
      }),
    );

    this.serial.addEventListener('state', ({ detail }) => this.#onSerialState(detail));
    this.serial.addEventListener('line', ({ detail }) => {
      const isError = detail.text.startsWith('ERR');
      if (this.lcdPanel.playing && !isError && detail.text.startsWith('OK')) return; // evita inundar la consola
      this.status.log(isError ? 'err' : 'rx', detail.text);
      if (isError) this.status.notice('error', `El ESP32 respondió: ${detail.text}`, 'device-error');
    });
    this.serial.addEventListener('error', ({ detail }) => {
      this.status.log('err', detail.error.message);
      this.status.notice('error', `Error serial: ${detail.error.message}`, 'serial-error');
    });

    // Propiedades: se guardan por pantalla y se envían al soltar el control.
    on('brightness', 'input', (e) => {
      this.prefs.brightness = Number(e.target.value);
      this.$('[data-ref=brightness-value]').textContent = `${e.target.value}%`;
      if (this.source === 'config') this.#scheduleRefresh();
    });
    on('brightness', 'change', () => this.#run(() => this.sendConfig()));
    on('rotation', 'click', (e) => {
      const button = e.target.closest('[data-rot]');
      if (!button || Number(button.dataset.rot) === this.prefs.rotation) return;
      this.prefs.rotation = Number(button.dataset.rot);
      this.#setRotationUi(this.prefs.rotation);
      // En pantallas gráficas cambia el tamaño lógico del lienzo si no es cuadrado; el LCD solo gira la vista previa.
      if (this.config.mode === 'graphic') this.graphic.setDisplay(this.config, this.prefs.rotation);
      this.#layoutCanvases();
      this.#scheduleRefresh();
      this.#run(() => this.sendConfig());
    });

    // Herramientas gráficas.
    this.root.querySelectorAll('[data-tool]').forEach((button) =>
      button.addEventListener('click', () => {
        this.editor.tool = button.dataset.tool;
        this.root.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      }),
    );
    on('color', 'input', (e) => (this.editor.color = e.target.value));
    on('brush', 'input', (e) => {
      this.editor.size = Number(e.target.value);
      this.$('[data-ref=brush-value]').textContent = `${e.target.value} px`;
    });
  }

  #onSerialState({ state, reason }) {
    this.lcdPanel.stop();
    this.graphic.stop();
    this.status.setConnection(state);
    const button = this.$('[data-ref=connect]');
    const connected = state === 'connected';
    button.innerHTML = `${icon(connected ? 'unplug' : 'plug', 'h-3.5 w-3.5')}<span>${connected ? 'Desconectar' : 'Conectar'}</span>`;
    button.classList.toggle('btn-primary', !connected);
    button.disabled = state === 'connecting';
    if (connected) {
      this.status.log('sys', 'Puerto abierto a 921600 baud.');
      this.status.dismissNotice('device-error');
      this.status.dismissNotice('lost');
    }
    if (state === 'disconnected') {
      this.status.setProgress(0, 0);
      if (reason) this.status.log('sys', reason);
      if (reason && !reason.startsWith('Desconectado por')) {
        this.status.notice('warn', `${reason}. Vuelve a conectar para continuar.`, 'lost');
      }
    }
  }

  /** Redimensionado del dock inferior (arrastrar, flechas o maximizar) para ver más filas del bus. */
  #bindDock() {
    const main = this.$('[data-ref=main-col]');
    const handle = this.$('[data-ref=dock-resizer]');
    const setHeight = (px) => {
      const max = main.clientHeight - 330; // deja siempre sitio al lienzo y a la tira de fotogramas
      const value = Math.max(160, Math.min(px, max));
      main.style.setProperty('--dock-h', `${value}px`);
      try { localStorage.setItem('dockHeight', String(value)); } catch { /* sin almacenamiento */ }
      this.graphic.layout();
    };
    try {
      const saved = Number(localStorage.getItem('dockHeight'));
      if (saved) main.style.setProperty('--dock-h', `${saved}px`);
    } catch { /* sin almacenamiento */ }

    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => setHeight(main.getBoundingClientRect().bottom - ev.clientY - 4);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (e) => {
      const delta = { ArrowUp: 32, ArrowDown: -32 }[e.key];
      if (!delta) return;
      e.preventDefault();
      setHeight(this.$('[data-ref=dock]').clientHeight + delta);
    });
    this.$('[data-ref=dock-max]').addEventListener('click', () => {
      this.#setDockCollapsed(false);
      const dock = this.$('[data-ref=dock]');
      setHeight(dock.clientHeight > main.clientHeight * 0.55 ? main.clientHeight * 0.34 : main.clientHeight);
    });
    this.$('[data-ref=dock-toggle]').addEventListener('click', () => this.#setDockCollapsed(!this.#dockCollapsed));
  }

  #dockCollapsed = false;

  /** Plegado, el dock deja solo la barra de pestañas y devuelve el espacio al editor. */
  #setDockCollapsed(collapsed) {
    if (collapsed === this.#dockCollapsed) return;
    this.#dockCollapsed = collapsed;
    const dock = this.$('[data-ref=dock]');
    dock.classList.toggle('!h-9', collapsed);
    dock.classList.toggle('!min-h-0', collapsed);
    this.$('[data-ref=dock-resizer]').classList.toggle('lg:block', !collapsed);
    const toggle = this.$('[data-ref=dock-toggle]');
    toggle.innerHTML = icon(collapsed ? 'chevron-up' : 'chevron-down', 'h-3.5 w-3.5');
    toggle.title = collapsed ? 'Mostrar panel' : 'Ocultar panel';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    requestAnimationFrame(() => this.graphic.layout());
  }

  #setRotationUi(rotation) {
    this.root.querySelectorAll('[data-rot]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.rot) === rotation)));
  }

  // ------------------------------------------------------------- UI dinámica

  #openPicker() {
    openDisplayPicker({
      current: this.displayKey,
      onSelect: (key) => key !== this.displayKey && this.selectDisplay(key),
      onAdd: () => openDisplayModal({ onSaved: (key, extras) => this.#afterDisplaysChanged(key, extras) }),
      onEdit: (key) => openDisplayModal({ editingKey: key, onSaved: (k, extras) => this.#afterDisplaysChanged(k, extras) }),
      onDelete: (key) => this.#deleteDisplay(key),
    });
  }

  async #deleteDisplay(key) {
    const ok = await confirmModal({
      title: 'Eliminar pantalla',
      message: `Se eliminará "${DISPLAYS[key].label}" de este navegador. Sus dibujos y ajustes se pierden.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    removeDisplay(key);
    saveCustomDisplays();
    this.#settings.delete(key);
    this.#afterDisplaysChanged(key === this.displayKey ? DEFAULT_DISPLAY : this.displayKey);
  }

  #afterDisplaysChanged(selectKey, extras = null) {
    // Una pantalla creada o editada puede cambiar de tamaño o de buses: sus ajustes se recalculan.
    if (extras) this.#settings.delete(selectKey);
    const design = extras?.design;
    this.selectDisplay(selectKey);
    if (design && this.config.mode === 'graphic') this.graphic.applyDesign(design);
  }

  // ---------------------------------------------------------------- plantilla

  #template() {
    const rotationButtons = ROTATIONS.map((r) => `<button type="button" role="radio" data-rot="${r}" aria-checked="false" class="flex-1 tabular-nums">${r * 90}°</button>`).join('');
    const dockTab = (id, label, ico, selected) => `<button type="button" role="tab" data-dock="${id}" aria-selected="${selected}" class="tab">${icon(ico, 'h-3.5 w-3.5')}${label}</button>`;
    return `
    <div class="flex min-h-screen flex-col lg:h-[100dvh] lg:min-h-0 lg:overflow-hidden">
      <header class="flex h-12 shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-900 pl-3 pr-2">
        <span class="text-accent">${logo('h-5 w-5')}</span>
        <h1 class="hidden pr-1 text-[13px] font-semibold text-white sm:block">Display Studio</h1>
        <span class="divider-v hidden sm:block"></span>
        <button type="button" data-ref="display-pick" class="btn btn-ghost !h-8 min-w-0 gap-2 !px-2 !text-slate-200" aria-haspopup="dialog" title="Cambiar de pantalla">
          ${icon('monitor', 'h-3.5 w-3.5 text-slate-400')}
          <span data-ref="display-name" class="truncate text-[13px] font-medium text-white"></span>
          <span data-ref="display-meta" class="hidden tabular-nums text-slate-500 sm:inline"></span>
          ${icon('chevron-down', 'h-3.5 w-3.5 text-slate-500')}
        </button>
        <div class="ml-auto flex items-center gap-1">
          <div data-ref="badge" class="mr-1 hidden h-7 items-center gap-2 rounded-md px-2 text-xs text-slate-400 md:flex" role="status" aria-live="polite"></div>
          <button type="button" data-ref="browser-info" class="btn btn-ghost btn-icon" title="Navegadores compatibles" aria-label="Navegadores compatibles">${icon('info', 'h-3.5 w-3.5')}</button>
          <button type="button" data-ref="send-config" data-needs-idle class="btn btn-ghost btn-icon" title="Enviar configuración (brillo y rotación)" aria-label="Enviar configuración">${icon('sliders', 'h-3.5 w-3.5')}</button>
          <button type="button" data-ref="clear-content" class="btn btn-ghost btn-icon hover:!text-red-300" title="Limpiar lienzo" aria-label="Limpiar lienzo">${icon('trash', 'h-3.5 w-3.5')}</button>
          <button type="button" data-ref="send-content" data-needs-idle class="btn" title="Enviar el contenido actual a la pantalla">${icon('send', 'h-3.5 w-3.5')}Enviar</button>
          <span class="divider-v mx-1"></span>
          <button type="button" data-ref="connect" class="btn btn-primary">${icon('plug', 'h-3.5 w-3.5')}<span>Conectar</span></button>
        </div>
      </header>

      <div class="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_252px]">
        <main data-ref="main-col" class="flex min-h-0 min-w-0 flex-col" style="--dock-h: 34%">
          <div class="min-h-[26rem] flex-1 lg:min-h-0">
            <div data-ref="graphic-panel" class="h-full"><div data-ref="graphic-root" class="h-full"></div></div>
            <div data-ref="lcd-panel" class="h-full" hidden>
              <section data-ref="lcd-root" class="h-full bg-ink-900" aria-label="Editor del LCD"></section>
            </div>
          </div>

          <div data-ref="dock-resizer" role="separator" aria-orientation="horizontal" aria-label="Redimensionar el panel inferior" tabindex="0"
            class="relative z-10 -my-[3px] hidden h-[7px] shrink-0 cursor-row-resize after:absolute after:inset-x-0 after:top-[3px] after:h-px after:bg-ink-600 after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent lg:block"></div>
          <section data-ref="dock" class="flex h-72 shrink-0 flex-col overflow-hidden bg-ink-900 lg:h-[var(--dock-h)] lg:min-h-[9rem]" aria-label="Bus, consola y código">
            <div class="flex h-9 shrink-0 items-center justify-between border-b border-ink-600 px-2" role="tablist">
              <div class="flex">${dockTab('bus', 'Bus', 'bus', true)}${dockTab('console', 'Consola', 'terminal', false)}${dockTab('code', 'Código C', 'code', false)}</div>
              <div class="flex items-center gap-0.5">
                <button type="button" data-ref="clear-console" class="btn btn-ghost btn-icon hidden" aria-label="Limpiar consola" title="Limpiar consola">${icon('trash', 'h-3.5 w-3.5')}</button>
                <button type="button" data-ref="dock-max" class="btn btn-ghost btn-icon hidden lg:inline-flex" title="Ampliar o reducir el panel" aria-label="Ampliar o reducir el panel">${icon('maximize', 'h-3.5 w-3.5')}</button>
                <button type="button" data-ref="dock-toggle" class="btn btn-ghost btn-icon" title="Ocultar panel" aria-expanded="true">${icon('chevron-down', 'h-3.5 w-3.5')}</button>
              </div>
            </div>
            <div data-dock-panel="bus" data-ref="bus-root" class="min-h-0 flex-1"></div>
            <div data-dock-panel="code" data-ref="code-root" class="min-h-0 flex-1" hidden></div>
            <div data-dock-panel="console" data-ref="console" role="log" aria-live="polite" tabindex="0" class="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px]" hidden></div>
          </section>
        </main>

        <aside class="flex min-h-0 flex-col border-l border-ink-600 bg-ink-900 lg:overflow-y-auto" aria-label="Vista previa y propiedades">
          <section aria-labelledby="h-prev" class="border-b border-ink-600">
            <h2 id="h-prev" class="panel-head border-0">Vista previa del panel</h2>
            <div class="px-3 pb-3">
              <div data-ref="preview-graphic" class="bench h-44 rounded-lg border border-ink-600">
                <div data-ref="preview-box" class="flex h-full w-full items-center justify-center">
                  <canvas data-ref="preview-canvas" class="pixelated block" aria-label="Vista previa de lo que se enviará"></canvas>
                </div>
              </div>
              <div data-ref="preview-lcd" hidden>
                <div data-ref="lcd-box" class="bench flex items-center justify-center overflow-hidden rounded-lg border border-ink-600 p-2">
                  <canvas data-ref="lcd-preview" class="pixelated block rounded-sm" aria-label="Vista previa del LCD"></canvas>
                </div>
              </div>
              <p data-ref="rotation-note" class="mt-2 text-2xs leading-snug text-slate-500"></p>
            </div>
          </section>

          <section aria-labelledby="h-props" class="border-b border-ink-600">
            <h2 id="h-props" class="panel-head border-0">Propiedades</h2>
            <div class="space-y-3 px-3 pb-3">
              <div>
                <div class="flex items-center justify-between"><label class="field-label !mb-0 flex items-center gap-1.5" for="brightness">${icon('sun', 'h-3 w-3')}Brillo</label><output data-ref="brightness-value" for="brightness" class="text-2xs tabular-nums text-slate-400">70%</output></div>
                <input id="brightness" data-ref="brightness" type="range" min="0" max="100" value="70" class="mt-1 w-full" />
              </div>
              <div>
                <span id="rotation-label" class="field-label flex items-center gap-1.5">${icon('rotate', 'h-3 w-3')}Rotación</span>
                <div data-ref="rotation" role="radiogroup" aria-labelledby="rotation-label" class="seg w-full">${rotationButtons}</div>
              </div>
            </div>
          </section>

          <section aria-labelledby="h-info">
            <h2 id="h-info" class="panel-head border-0">Pantalla</h2>
            <dl data-ref="prop-summary" class="space-y-1 px-3 pb-3 text-2xs"></dl>
          </section>
        </aside>
      </div>

      <div data-ref="notices" class="pointer-events-none fixed bottom-3 right-3 z-50 flex w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col gap-2" aria-live="polite"></div>
    </div>`;
  }
}
