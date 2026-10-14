import { commands } from '../serial/protocol.js';
import { GLYPH_MARKS, GLYPH_SLOTS, sanitizeText, textToCodes } from './lcd-editor.js';

/*
  Un frame = líneas de texto + (opcional) redefiniciones de glifos CGRAM + duración.
  Al enviarlo: primero "glyph" por cada slot redefinido y luego un "lcdRaw" por fila
  completa. Sobrescribir cada fila evita lcd.clear(), que haría parpadear el LCD.
*/

export const PRESETS = [
  { id: 'marquee', label: 'Texto desplazado', text: 'Hola desde el ESP32 ', usesText: true },
  { id: 'typewriter', label: 'Máquina de escribir', text: 'Hola mundo', usesText: true },
  { id: 'blink', label: 'Parpadeo', text: 'ALERTA', usesText: true },
  { id: 'loading', label: 'Barra de carga (glifos)', text: '', usesText: false },
  { id: 'spinner', label: 'Spinner (glifo animado)', text: 'Cargando', usesText: true },
  { id: 'heart', label: 'Corazón latiendo', text: 'Te quiero', usesText: true },
  { id: 'bounce', label: 'Pelota rebotando', text: '', usesText: false },
];

const BAR_GLYPHS = [16, 24, 28, 30].map((bits) => new Array(8).fill(bits)); // 1 a 4 columnas llenas
const SPINNER = [
  [4, 4, 4, 4, 4, 4, 4, 0],
  [1, 1, 2, 2, 4, 8, 8, 16],
  [0, 0, 0, 31, 0, 0, 0, 0],
  [16, 8, 8, 4, 2, 2, 1, 1],
];
const HEART_SMALL = [0, 0, 10, 31, 14, 4, 0, 0];
const HEART_BIG = [0, 10, 31, 31, 31, 14, 4, 0];
const BALL = [0, 14, 31, 31, 31, 14, 0, 0];

export class LcdAnimation {
  frames = [];
  selected = 0;
  loop = true;
  cols = 16;
  rows = 2;

  constructor() {
    this.frames = [this.#blankFrame()];
  }

  #blankFrame(ms = 500) {
    return { lines: Array(this.rows).fill(''), glyphs: {}, ms };
  }

  setDisplay({ cols, rows }) {
    this.cols = cols;
    this.rows = rows;
    this.frames.forEach((frame) => {
      frame.lines = Array.from({ length: rows }, (_, i) => sanitizeText(frame.lines[i] ?? '', cols));
    });
  }

  get frame() {
    return this.frames[this.selected];
  }

  select(index) {
    this.selected = Math.max(0, Math.min(index, this.frames.length - 1));
  }

  add() {
    this.frames.splice(this.selected + 1, 0, this.#blankFrame(this.frame.ms));
    this.selected++;
  }

  duplicate() {
    const copy = structuredClone(this.frame);
    this.frames.splice(this.selected + 1, 0, copy);
    this.selected++;
  }

  remove() {
    if (this.frames.length === 1) {
      this.frames[0] = this.#blankFrame();
      return;
    }
    this.frames.splice(this.selected, 1);
    this.selected = Math.min(this.selected, this.frames.length - 1);
  }

  move(direction) {
    const to = this.selected + direction;
    if (to < 0 || to >= this.frames.length) return;
    [this.frames[this.selected], this.frames[to]] = [this.frames[to], this.frames[this.selected]];
    this.selected = to;
  }

  setAllDelays(ms) {
    this.frames.forEach((frame) => (frame.ms = ms));
  }

  /** Tabla CGRAM tal como estaría tras reproducir los frames 0..index. */
  glyphTableAt(index, base) {
    const table = base.map((rows) => [...rows]);
    for (let i = 0; i <= index; i++) {
      for (const [slot, rows] of Object.entries(this.frames[i].glyphs)) table[Number(slot)] = [...rows];
    }
    return table;
  }

  /** Comandos JSON de un frame (glifos redefinidos + todas las filas). */
  compileFrame(index) {
    const frame = this.frames[index];
    return [
      ...Object.entries(frame.glyphs).map(([slot, rows]) => commands.glyph(Number(slot), rows)),
      ...frame.lines.map((line, row) => commands.lcdRaw(row, 0, textToCodes(line, this.cols))),
    ];
  }

  generate(presetId, { text, row }) {
    const { cols, rows } = this;
    const at = Math.min(row, rows - 1);
    const frame = (content, ms, glyphs = {}) => {
      const lines = Array(rows).fill('');
      lines[at] = typeof content === 'string' ? content : content[0];
      if (Array.isArray(content)) content.slice(1).forEach((extra, i) => at + 1 + i < rows && (lines[at + 1 + i] = extra));
      return { lines: lines.map((l) => sanitizeText(l, cols)), glyphs, ms };
    };
    const mark = GLYPH_MARKS[0];
    let frames = [];

    switch (presetId) {
      case 'marquee': {
        const tape = ' '.repeat(cols) + (text || ' ') + ' '.repeat(cols);
        for (let i = 0; i <= tape.length - cols; i++) frames.push(frame(tape.slice(i, i + cols), 140));
        break;
      }
      case 'typewriter': {
        const full = sanitizeText(text, cols);
        for (let n = 1; n <= full.length; n++) frames.push(frame(full.slice(0, n), 120));
        if (frames.length) frames.at(-1).ms = 900;
        break;
      }
      case 'blink':
        frames = [frame(text, 500), frame('', 500)];
        break;
      case 'loading': {
        const width = cols - 2;
        const steps = width * 5;
        const defs = Object.fromEntries(BAR_GLYPHS.map((bits, i) => [i, bits]));
        for (let s = 0; s <= steps; s++) {
          const full = Math.floor(s / 5);
          const part = s % 5;
          const bar = '█'.repeat(full) + (part ? GLYPH_MARKS[part - 1] : '') + ' '.repeat(width - full - (part ? 1 : 0));
          frames.push(frame([`[${bar}]`, `${Math.round((s / steps) * 100)}%`], 60, s === 0 ? defs : {}));
        }
        break;
      }
      case 'spinner':
        frames = SPINNER.map((bits) => frame(`${text} ${mark}`, 120, { 0: bits }));
        break;
      case 'heart':
        frames = [frame(`${text} ${mark}`, 450, { 0: HEART_SMALL }), frame(`${text} ${mark}`, 450, { 0: HEART_BIG })];
        break;
      case 'bounce': {
        const path = [...Array(cols).keys()];
        [...path, ...path.slice(1, -1).reverse()].forEach((col, i) =>
          frames.push(frame(' '.repeat(col) + mark, 80, i === 0 ? { 0: BALL } : {})),
        );
        break;
      }
      default:
        throw new Error(`Preset desconocido: ${presetId}`);
    }

    if (!frames.length) throw new Error('El preset no generó frames; escribe algún texto.');
    this.frames = frames;
    this.selected = 0;
  }
}

export { GLYPH_SLOTS };
