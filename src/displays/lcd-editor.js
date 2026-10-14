import { commands } from '../serial/protocol.js';

export const GLYPH_COLS = 5;
export const GLYPH_ROWS = 8;
export const GLYPH_SLOTS = 8;

// En el texto, los slots CGRAM 0-7 se escriben con estos símbolos de 1 carácter.
export const GLYPH_MARKS = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦'];

// Caracteres especiales de la ROM HD44780 variante A00 (la más común).
export const ROM_SPECIALS = [
  { char: '→', code: 0x7e, name: 'Flecha derecha' },
  { char: '←', code: 0x7f, name: 'Flecha izquierda' },
  { char: '°', code: 0xdf, name: 'Grado' },
  { char: '█', code: 0xff, name: 'Bloque lleno' },
  { char: 'α', code: 0xe0, name: 'Alfa' },
  { char: 'β', code: 0xe2, name: 'Beta' },
  { char: 'µ', code: 0xe4, name: 'Micro' },
  { char: 'σ', code: 0xe5, name: 'Sigma minúscula' },
  { char: 'ρ', code: 0xe6, name: 'Rho' },
  { char: '√', code: 0xe8, name: 'Raíz' },
  { char: '∞', code: 0xf3, name: 'Infinito' },
  { char: 'Ω', code: 0xf4, name: 'Omega' },
  { char: 'Σ', code: 0xf6, name: 'Sigma mayúscula' },
  { char: 'π', code: 0xf7, name: 'Pi' },
  { char: '÷', code: 0xfd, name: 'División' },
  { char: 'ä', code: 0xe1, name: 'a con diéresis' },
  { char: 'ö', code: 0xef, name: 'o con diéresis' },
  { char: 'ü', code: 0xf5, name: 'u con diéresis' },
  { char: 'ñ', code: 0xee, name: 'ñ' },
];

const CHAR_TO_CODE = new Map([
  ...ROM_SPECIALS.map(({ char, code }) => [char, code]),
  ...GLYPH_MARKS.map((char, slot) => [char, slot]),
]);
const CODE_TO_CHAR = new Map(ROM_SPECIALS.map(({ char, code }) => [code, char]));

/** Código de byte que verá el controlador HD44780, o null si no se puede mostrar. */
export function charToCode(char) {
  if (CHAR_TO_CODE.has(char)) return CHAR_TO_CODE.get(char);
  const cp = char.codePointAt(0);
  return cp >= 0x20 && cp <= 0x7e ? cp : null;
}

export function codeToChar(code) {
  return CODE_TO_CHAR.get(code) ?? String.fromCharCode(code);
}

export function sanitizeText(text, cols) {
  return Array.from(text, (char) => (charToCode(char) === null ? '?' : char)).slice(0, cols).join('');
}

/** Línea -> `cols` códigos, rellenando con espacios (0x20). */
export function textToCodes(line, cols) {
  const codes = Array.from(line, (char) => charToCode(char) ?? 0x3f).slice(0, cols);
  while (codes.length < cols) codes.push(0x20);
  return codes;
}

/**
 * Estado del LCD de caracteres: líneas de texto, 8 glifos CGRAM 5x8 y los
 * glifos colocados en pantalla. Refleja el firmware: enviar texto ("lcd")
 * ejecuta lcd.clear(), por lo que borra las posiciones.
 */
export class LcdEditor {
  config = null;
  lines = [];
  glyphs = Array.from({ length: GLYPH_SLOTS }, () => new Array(GLYPH_ROWS).fill(0));
  draft = new Array(GLYPH_ROWS).fill(0);
  slot = 0;
  placed = new Map(); // "col,row" -> slot

  setDisplay(config) {
    this.config = config;
    this.lines = Array.from({ length: config.rows }, (_, i) => sanitizeText(this.lines[i] ?? '', config.cols));
    for (const key of [...this.placed.keys()]) {
      const [col, row] = key.split(',').map(Number);
      if (col >= config.cols || row >= config.rows) this.placed.delete(key);
    }
  }

  setLine(index, text) {
    this.lines[index] = sanitizeText(text, this.config.cols);
    return this.lines[index];
  }

  selectSlot(slot) {
    this.slot = slot;
    this.draft = [...this.glyphs[slot]];
  }

  // En HD44780 el bit 4 de cada fila es la columna izquierda.
  isDotOn(row, col) {
    return (this.draft[row] & (1 << (GLYPH_COLS - 1 - col))) !== 0;
  }

  toggleDot(row, col) {
    this.draft[row] ^= 1 << (GLYPH_COLS - 1 - col);
  }

  clearDraft() {
    this.draft.fill(0);
  }

  invertDraft() {
    this.draft = this.draft.map((row) => ~row & 0x1f);
  }

  /**
   * Comandos para mostrar `lines`. Si todo es ASCII basta "lcd"; con caracteres
   * especiales o glifos se envía "lcd" (con espacios) y luego "lcdRaw" por cada tramo.
   */
  textCommands(lines = this.lines) {
    const { cols } = this.config;
    if (lines.every((line) => /^[\x20-\x7e]*$/.test(line))) return [commands.lcd([...lines])];

    const ascii = lines.map((line) => Array.from(line, (c) => (/^[\x20-\x7e]$/.test(c) ? c : ' ')).join(''));
    const result = [commands.lcd(ascii)];
    lines.forEach((line, row) => {
      const chars = Array.from(line).slice(0, cols);
      let col = 0;
      while (col < chars.length) {
        if (/^[\x20-\x7e]$/.test(chars[col])) { col++; continue; }
        const start = col;
        while (col < chars.length && !/^[\x20-\x7e]$/.test(chars[col])) col++;
        result.push(commands.lcdRaw(row, start, chars.slice(start, col).map((c) => charToCode(c) ?? 0x3f)));
      }
    });
    return result;
  }

  /** Marca el texto como enviado: el LCD se limpió, así que los glifos colocados desaparecen. */
  markTextSent() {
    this.placed.clear();
  }

  glyphCommand() {
    return commands.glyph(this.slot, [...this.draft]);
  }

  commitGlyph() {
    this.glyphs[this.slot] = [...this.draft];
  }

  glyphAtCommand(slot, col, row) {
    if (col < 0 || col >= this.config.cols || row < 0 || row >= this.config.rows) {
      throw new Error(`Posición fuera del LCD (columna 0-${this.config.cols - 1}, fila 0-${this.config.rows - 1}).`);
    }
    return commands.glyphAt(slot, col, row);
  }

  place(slot, col, row) {
    this.placed.set(`${col},${row}`, slot);
  }

  clearScreen() {
    this.lines = this.lines.map(() => '');
    this.placed.clear();
  }

  /**
   * Dibuja el LCD en un canvas: caracteres con fuente monoespaciada y glifos punto a punto.
   * `lines`, `glyphs` y `placed` se pueden sustituir (la animación usa los de cada frame).
   */
  render(canvas, { lines = this.lines, glyphs = this.glyphs, placed = this.placed } = {}) {
    const { cols, rows } = this.config;
    const dot = 3;
    const gap = 1;
    const pad = 4;
    const cellW = GLYPH_COLS * (dot + gap) + pad;
    const cellH = GLYPH_ROWS * (dot + gap) + pad;
    canvas.width = cols * cellW + pad;
    canvas.height = rows * cellH + pad;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#5f7f2a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0f1d08';
    ctx.font = `bold ${Math.round(cellH * 0.78)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let row = 0; row < rows; row++) {
      const codes = textToCodes(lines[row] ?? '', cols);
      for (let col = 0; col < cols; col++) {
        const x = pad + col * cellW;
        const y = pad + row * cellH;
        ctx.globalAlpha = 0.12; // celda apagada
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        ctx.globalAlpha = 1;

        const slot = placed.get(`${col},${row}`) ?? (codes[col] < 8 ? codes[col] : undefined);
        if (slot !== undefined) {
          this.#drawGlyph(ctx, glyphs[slot], x + pad / 2, y + pad / 2, dot, gap);
        } else if (codes[col] !== 0x20) {
          ctx.fillText(codeToChar(codes[col]), x + cellW / 2, y + cellH / 2 + 1);
        }
      }
    }
  }

  #drawGlyph(ctx, rowsBits, x, y, dot, gap) {
    for (let r = 0; r < GLYPH_ROWS; r++) {
      for (let c = 0; c < GLYPH_COLS; c++) {
        if (rowsBits[r] & (1 << (GLYPH_COLS - 1 - c))) {
          ctx.fillRect(x + c * (dot + gap), y + r * (dot + gap), dot, dot);
        }
      }
    }
  }
}
