import { logicalSize } from '../displays/display-configs.js';

const DEFAULT_MS = 200;

/**
 * Lienzo de dibujo a resolución lógica del display. El tamaño CSS lo escala sin
 * suavizado (clase `pixelated`); los trazos usan pinceles cuadrados y Bresenham.
 *
 * Cada combinación pantalla + orientación (horizontal/vertical) tiene su propio
 * documento: una lista de fotogramas, de los que el lienzo muestra el seleccionado.
 */
export class CanvasEditor {
  tool = 'pen';
  color = '#ffffff';
  size = 2;
  monochrome = false;
  paper = false; // e-paper: fondo blanco (papel) y el lápiz pinta tinta negra
  locked = false; // true durante la reproducción: evita editar mientras se envía

  #ctx;
  #drawing = false;
  #last = null;
  #docs = new Map();
  #doc = null;

  constructor(canvas, { onChange, onFramesChange }) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.onFramesChange = onFramesChange;
    this.#ctx = canvas.getContext('2d', { willReadFrequently: true });

    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    canvas.addEventListener('pointerup', (e) => this.#up(e));
    canvas.addEventListener('pointercancel', (e) => this.#up(e));
  }

  get frames() {
    return this.#doc.frames;
  }

  get selected() {
    return this.#doc.selected;
  }

  /** Objetos (SVG/imágenes) colocados en el fotograma seleccionado: { name, x, y, image: ImageData }. */
  get objects() {
    return this.frames[this.selected].objects;
  }

  addObject(object) {
    this.objects.push(object);
  }

  get loop() {
    return this.#doc.loop;
  }

  set loop(value) {
    this.#doc.loop = value;
  }

  setDisplay(config, rotation = 0) {
    this.#commit();
    this.monochrome = config.type === 'mono';
    this.paper = config.profile?.kind === 'epaper';
    const { width, height } = logicalSize(config, rotation);
    const key = `${config.key}:${width}x${height}`;
    if (!this.#docs.has(key)) this.#docs.set(key, { frames: [{ data: null, ms: DEFAULT_MS, objects: [] }], selected: 0, loop: true });
    this.#doc = this.#docs.get(key);
    this.canvas.width = width;
    this.canvas.height = height;
    this.#ctx.imageSmoothingEnabled = false;
    this.#load();
    this.onFramesChange();
    this.onChange();
  }

  // ------------------------------------------------------------- fotogramas

  select(index) {
    this.#commit();
    this.#doc.selected = Math.max(0, Math.min(index, this.frames.length - 1));
    this.#load();
    this.onFramesChange();
    this.onChange();
  }

  add() {
    this.#insert({ data: null, ms: this.frames[this.selected].ms, objects: [] });
  }

  duplicate() {
    this.#commit();
    const { data, ms, objects } = this.frames[this.selected];
    this.#insert({ data: data ? new ImageData(new Uint8ClampedArray(data.data), data.width, data.height) : null, ms, objects: [...objects] });
  }

  remove() {
    this.#commit();
    if (this.frames.length === 1) this.frames[0] = { data: null, ms: this.frames[0].ms, objects: [] };
    else {
      this.frames.splice(this.selected, 1);
      this.#doc.selected = Math.min(this.selected, this.frames.length - 1);
    }
    this.#load();
    this.onFramesChange();
    this.onChange();
  }

  move(direction) {
    this.#commit();
    const from = this.selected;
    const to = from + direction;
    if (to < 0 || to >= this.frames.length) return;
    [this.frames[from], this.frames[to]] = [this.frames[to], this.frames[from]];
    this.#doc.selected = to;
    this.onFramesChange();
  }

  /** Sustituye todos los fotogramas. `items` = [{ data: ImageData, ms }]. */
  setFrames(items) {
    this.#doc.frames = items.map(({ data, ms }) => ({ data, ms, objects: [] }));
    this.#doc.selected = 0;
    this.#load();
    this.onFramesChange();
    this.onChange();
  }

  /** Añade fotogramas al final y deja seleccionado el primero de los nuevos. */
  appendFrames(items) {
    this.#commit();
    const first = this.frames.length;
    this.frames.push(...items.map(({ data, ms }) => ({ data, ms, objects: [] })));
    this.#doc.selected = first;
    this.#load();
    this.onFramesChange();
    this.onChange();
  }

  /**
   * Escribe fotogramas en el documento de cualquier pantalla y orientación sin cambiar el lienzo
   * activo (importación de Figma). Si es el documento abierto, equivale a setFrames/appendFrames.
   */
  importFrames(config, rotation, items, mode = 'replace') {
    const { width, height } = logicalSize(config, rotation);
    const key = `${config.key}:${width}x${height}`;
    const doc = this.#docs.get(key);
    if (doc && doc === this.#doc) return mode === 'append' ? this.appendFrames(items) : this.setFrames(items);
    const frames = items.map(({ data, ms }) => ({ data, ms, objects: [] }));
    if (!doc || mode === 'replace') this.#docs.set(key, { frames, selected: 0, loop: doc?.loop ?? true });
    else {
      doc.selected = doc.frames.length;
      doc.frames.push(...frames);
    }
  }

  setAllDelays(ms) {
    this.frames.forEach((frame) => (frame.ms = ms));
  }

  /** Imagen de un fotograma; el seleccionado se lee en vivo del lienzo. */
  frameImage(index) {
    if (index === this.selected) return this.getImageData();
    return this.frames[index].data ?? this.#blank();
  }

  #blank() {
    const image = new ImageData(this.canvas.width, this.canvas.height);
    const v = this.paper ? 255 : 0;
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
    return image;
  }

  #insert(frame) {
    this.#commit();
    this.frames.splice(this.selected + 1, 0, frame);
    this.#doc.selected++;
    this.#load();
    this.onFramesChange();
    this.onChange();
  }

  #commit() {
    if (this.#doc) this.#doc.frames[this.#doc.selected].data = this.getImageData();
  }

  #load() {
    const { data } = this.frames[this.selected];
    if (data && data.width === this.canvas.width && data.height === this.canvas.height) this.#ctx.putImageData(data, 0, 0);
    else this.#fillBlack();
  }

  // ------------------------------------------------------------------ lienzo

  clear() {
    this.frames[this.selected].objects = [];
    this.#fillBlack();
    this.onChange();
  }

  getImageData() {
    return this.#ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Ejecuta `draw(ctx)` sobre el lienzo (p. ej. fijar un SVG) y notifica el cambio. */
  paint(draw) {
    draw(this.#ctx);
    this.onChange();
  }

  get background() {
    return this.paper ? '#ffffff' : '#000000';
  }

  get ink() {
    return this.paper ? '#000000' : '#ffffff';
  }

  #fillBlack() {
    this.#ctx.fillStyle = this.background;
    this.#ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  #toPixel(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.floor(((event.clientX - rect.left) * this.canvas.width) / rect.width),
      y: Math.floor(((event.clientY - rect.top) * this.canvas.height) / rect.height),
    };
  }

  #stamp(x, y) {
    const offset = Math.floor(this.size / 2);
    // En pantallas monocromas el píxel encendido siempre es blanco.
    this.#ctx.fillStyle = this.tool === 'eraser' ? this.background : this.monochrome ? this.ink : this.color;
    this.#ctx.fillRect(x - offset, y - offset, this.size, this.size);
  }

  #line(from, to) {
    let { x, y } = from;
    const dx = Math.abs(to.x - x);
    const dy = -Math.abs(to.y - y);
    const sx = x < to.x ? 1 : -1;
    const sy = y < to.y ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      this.#stamp(x, y);
      if (x === to.x && y === to.y) break;
      const e2 = 2 * error;
      if (e2 >= dy) { error += dy; x += sx; }
      if (e2 <= dx) { error += dx; y += sy; }
    }
  }

  #down(event) {
    if (event.button !== 0 || this.locked) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.#drawing = true;
    this.#last = this.#toPixel(event);
    this.#stamp(this.#last.x, this.#last.y);
    this.onChange();
  }

  #move(event) {
    if (!this.#drawing) return;
    const point = this.#toPixel(event);
    this.#line(this.#last, point);
    this.#last = point;
    this.onChange();
  }

  #up(event) {
    this.#drawing = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  }
}
