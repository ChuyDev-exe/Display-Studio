/*
  Perfil de protocolo: describe cómo hablarle a cualquier controlador de pantalla
  sin código específico. Lo usan el inspector de bus (bus-encoder.js), la exportación
  de C (code-export.js) y el lector de hojas de datos (datasheet.js).

  Las secuencias (arranque y refresco) se guardan como texto editable:

    01            # SWRESET
    delay 150
    3A 55         # COLMOD: el primer byte es el comando, el resto son parámetros
    busy          # espera a que el pin BUSY se libere
    reset         # pulso en el pin RESET

  Se aceptan "3A 55", "0x3A, 0x55", "3Ah 55h" y comentarios con # o //.
*/

import { formatInfo } from './native-format.js';

export const PANEL_KINDS = [
  { id: 'mono', label: 'Monocromo', on: '#d7ecff', off: '#05080c' },
  { id: 'lcd', label: 'LCD mono', on: '#1b2a14', off: '#9bb585' }, // píxel activo oscuro sobre fondo verdoso
  { id: 'epaper', label: 'E-paper', on: '#e7e4dc', off: '#1d1d1f' }, // claro = papel, oscuro = tinta
  { id: 'gray', label: 'Grises', on: '#f2f2f2', off: '#050505' },
  { id: 'color', label: 'Color', on: '#ffffff', off: '#000000' },
];

export const DC_MODES = [
  { id: 'pin', label: 'Pin D/C (SPI de 4 hilos o paralelo)' },
  { id: 'spi9', label: 'Bit D/C en SPI de 9 bits (3 hilos)' },
  { id: 'i2c', label: 'Byte de control I2C' },
];

export const WINDOW_MODES = [
  { id: 'addr', label: 'Ventana: columnas y filas' },
  { id: 'pages', label: 'Páginas de 8 filas (tipo SSD1306)' },
  { id: 'none', label: 'Sin ventana: escritura continua' },
];

/** Plantillas de partida: cubren las familias de controladores más habituales. */
export const TEMPLATES = {
  mipi: {
    label: 'TFT MIPI DCS (ST77xx, ILI9xxx, GC9xxx)',
    profile: {
      kind: 'color', buses: ['spi'], dc: 'pin',
      pixel: { format: 'rgb565', bitOn: true, bgr: false, lsbFirst: false },
      window: { mode: 'addr', col: 0x2a, row: 0x2b, coordBytes: 2, littleEndian: false, xUnit: 'px', offsetX: 0, offsetY: 0, curX: null, curY: null },
      write: 0x2c,
      init: '01          # SWRESET\ndelay 150\n11          # SLPOUT\ndelay 120\n3A 55       # COLMOD: 16 bits por píxel\n36 00       # MADCTL\n29          # DISPON\ndelay 20',
      update: '',
      brightness: { cmd: 0x51, max: 255 },
      rotate: { cmd: 0x36, values: [0x00, 0x60, 0xc0, 0xa0] },
      reset: true, busy: null,
    },
  },
  oledPages: {
    label: 'OLED por páginas (SSD13xx, SH11xx)',
    profile: {
      kind: 'mono', buses: ['i2c', 'spi'], dc: 'i2c', i2cAddr: 0x3c, i2cCtrl: { cmd: 0x00, data: 0x40 },
      pixel: { format: 'mono1-v', bitOn: true },
      window: { mode: 'pages', page: 0xb0, colLow: 0x00, colHigh: 0x10, offsetX: 0, offsetY: 0 },
      write: null,
      init: 'AE          # display off\nD5 80\nA8 3F       # multiplex (alto - 1)\nD3 00\n40\n8D 14       # charge pump\nA1\nC8\nDA 12\n81 CF\nD9 F1\nDB 40\nA4\nA6\nAF          # display on',
      update: '',
      brightness: { cmd: 0x81, max: 255 },
      rotate: null,
      reset: true, busy: null,
    },
  },
  oledColor: {
    label: 'OLED color (SSD1351, SSD1331)',
    profile: {
      kind: 'color', buses: ['spi'], dc: 'pin',
      pixel: { format: 'rgb565', bitOn: true, bgr: false, lsbFirst: false },
      window: { mode: 'addr', col: 0x15, row: 0x75, coordBytes: 1, littleEndian: false, xUnit: 'px', offsetX: 0, offsetY: 0, curX: null, curY: null },
      write: 0x5c,
      init: 'FD 12       # desbloquear comandos\nFD B1\nAE          # display off\nB3 F1       # reloj\nCA 7F       # multiplex (alto - 1)\nA0 74       # remap: RGB565, COM por filas\nA2 00       # display offset\nAB 01       # regulador interno\nC7 0F       # contraste maestro\nAF          # display on',
      update: '',
      brightness: { cmd: 0xc7, max: 15 },
      rotate: null,
      reset: true, busy: null,
    },
  },
  oledGray: {
    label: 'OLED de grises (SSD1322, SSD1327)',
    profile: {
      kind: 'gray', buses: ['spi', 'i2c'], dc: 'pin', i2cAddr: 0x3c, i2cCtrl: { cmd: 0x00, data: 0x40 },
      pixel: { format: 'gray4', bitOn: true },
      window: { mode: 'addr', col: 0x15, row: 0x75, coordBytes: 1, littleEndian: false, xUnit: 'px', offsetX: 0, offsetY: 0, curX: null, curY: null },
      write: 0x5c,
      init: 'FD 12       # desbloquear comandos\nAE          # display off\nB3 91       # reloj\nCA 3F       # multiplex (alto - 1)\nA2 00       # display offset\nA0 14 11    # remap: nibbles, filas\nAB 01       # regulador interno\nC1 9F       # contraste\nA6          # modo normal\nAF          # display on',
      update: '',
      brightness: { cmd: 0xc1, max: 255 },
      rotate: null,
      reset: true, busy: null,
    },
  },
  epaperSsd: {
    label: 'E-paper SSD16xx (SSD1680, SSD1681, SSD1675)',
    profile: {
      kind: 'epaper', buses: ['spi'], dc: 'pin',
      pixel: { format: 'mono1-h', bitOn: true }, // RAM B/N del SSD16xx: 1 = blanco
      window: { mode: 'addr', col: 0x44, row: 0x45, coordBytes: 2, littleEndian: true, xUnit: 'byte', xBytes: 1, offsetX: 0, offsetY: 0, curX: 0x4e, curY: 0x4f },
      write: 0x24,
      init: 'reset\nbusy\n12          # SW reset\nbusy\n11 03       # data entry: X e Y crecientes\n3C 05       # border waveform\n18 80       # sensor de temperatura interno\nbusy',
      update: '22 F7       # display update control 2: refresco completo\n20          # master activation\nbusy',
      brightness: null,
      rotate: null,
      reset: true, busy: 'high',
    },
  },
  epaperUc: {
    label: 'E-paper UC81xx / IL0373',
    profile: {
      kind: 'epaper', buses: ['spi'], dc: 'pin',
      pixel: { format: 'mono1-h', bitOn: true },
      window: { mode: 'none' },
      write: 0x13,
      init: 'reset\nbusy\n04          # power on\nbusy\n00 1F       # panel setting: KW, LUT de OTP\n50 97       # VCOM y data interval',
      update: '12          # display refresh\ndelay 100\nbusy',
      brightness: null,
      rotate: null,
      reset: true, busy: 'low',
    },
  },
  blank: {
    label: 'Vacío',
    profile: {
      kind: 'color', buses: ['spi'], dc: 'pin',
      pixel: { format: 'rgb565', bitOn: true, bgr: false, lsbFirst: false },
      window: { mode: 'none' },
      write: null, init: '', update: '', brightness: null, rotate: null, reset: false, busy: null,
    },
  },
};

const BASE = {
  name: '', kind: 'color', buses: ['spi'], dc: 'pin', i2cAddr: 0x3c, i2cCtrl: { cmd: 0x00, data: 0x40 },
  pixel: { format: 'rgb565', bitOn: true, bgr: false, lsbFirst: false },
  window: { mode: 'addr', col: 0x2a, row: 0x2b, coordBytes: 2, littleEndian: false, xUnit: 'px', xBytes: 2, offsetX: 0, offsetY: 0, curX: null, curY: null, page: 0xb0, colLow: 0x00, colHigh: 0x10 },
  write: 0x2c, init: '', update: '', brightness: null, rotate: null, reset: true, busy: null, source: null,
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Perfil completo a partir de una plantilla (o de un perfil guardado, rellenando lo que falte). */
export function makeProfile(partial = TEMPLATES.mipi.profile) {
  const p = { ...clone(BASE), ...clone(partial) };
  p.pixel = { ...BASE.pixel, ...partial.pixel };
  p.window = { ...BASE.window, ...partial.window };
  p.i2cCtrl = { ...BASE.i2cCtrl, ...partial.i2cCtrl };
  return p;
}

export const kindInfo = (id) => PANEL_KINDS.find((k) => k.id === id) ?? PANEL_KINDS[3];

/** Tipo del editor: color si el formato nativo tiene color o grises; si no, monocromo. */
export const editorType = (profile) => (formatInfo(profile.pixel.format).kind === 'mono' ? 'mono' : 'tft');

// ------------------------------------------------------------- secuencias

const HEX = /^(?:0x)?([0-9a-f]{1,2})h?$/i;

/**
 * Texto -> pasos [{ cmd, data, delay, busy, reset, note, line }] y errores [{ line, message }].
 * `delay N` y `busy` se aplican al paso anterior; solos al principio crean un paso de espera.
 */
export function parseSequence(text = '') {
  const steps = [];
  const errors = [];
  const push = (step) => steps.push({ cmd: null, data: [], delay: 0, busy: false, reset: false, note: '', ...step });

  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const [body, ...comment] = raw.split(/#|\/\//);
    const note = comment.join(' ').trim();
    const tokens = body.replace(/[,{};]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    const word = tokens[0].toLowerCase();

    const delayMatch = word.match(/^(\d+)ms$/);
    if (['delay', 'wait', 'ms', 'sleep'].includes(word) || delayMatch) {
      const ms = Number(delayMatch ? delayMatch[1] : tokens[1]);
      if (!Number.isFinite(ms) || ms < 0 || ms > 60000) return errors.push({ line, message: `Línea ${line}: la espera debe ser de 0 a 60000 ms.` });
      const last = steps[steps.length - 1];
      if (last && !last.delay) last.delay = ms;
      else push({ delay: ms, note, line });
      return;
    }
    if (word === 'busy') {
      const last = steps[steps.length - 1];
      if (last && !last.busy && last.cmd !== null) last.busy = true;
      else push({ busy: true, note, line });
      return;
    }
    if (word === 'reset') return push({ reset: true, note, line });

    const bytes = [];
    for (const token of tokens) {
      const m = token.match(HEX);
      if (!m) return errors.push({ line, message: `Línea ${line}: "${token}" no es un byte hexadecimal.` });
      bytes.push(parseInt(m[1], 16));
    }
    if (bytes.length > 64) return errors.push({ line, message: `Línea ${line}: más de 64 parámetros.` });
    push({ cmd: bytes[0], data: bytes.slice(1), note, line });
  });
  return { steps, errors };
}

const H2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** Pasos -> texto (para insertar comandos desde la tabla de la hoja de datos). */
export function stepLine(cmd, data = [], note = '') {
  const bytes = [cmd, ...data].map(H2).join(' ');
  return note ? `${bytes.padEnd(12)}# ${note}` : bytes;
}

/** Bytes de una coordenada según el perfil (1 o 2 bytes, orden alto o bajo primero). */
export function coordBytes(value, count, littleEndian) {
  if (count === 1) return [value & 0xff];
  return littleEndian ? [value & 0xff, (value >> 8) & 0xff] : [(value >> 8) & 0xff, value & 0xff];
}

/**
 * Parámetros de los comandos de ventana para un frame completo de w x h nativos.
 * Devuelve [{ cmd, data, desc }] (también los contadores de RAM si existen).
 */
export function windowCommands(profile, w, h) {
  const win = profile.window;
  if (win.mode !== 'addr') return [];
  const byteUnits = win.xUnit === 'byte';
  // En e-paper la X suele contarse en bytes de 8 píxeles; la Y siempre en filas.
  const x0 = byteUnits ? Math.floor(win.offsetX / 8) : win.offsetX;
  const x1 = byteUnits ? x0 + Math.ceil(w / 8) - 1 : x0 + w - 1;
  const y0 = win.offsetY;
  const y1 = y0 + h - 1;
  const xCount = byteUnits ? (win.xBytes ?? 1) : win.coordBytes;
  const out = [];
  if (win.col != null) out.push({ cmd: win.col, data: [...coordBytes(x0, xCount, win.littleEndian), ...coordBytes(x1, xCount, win.littleEndian)], desc: `Columnas ${x0} a ${x1}${byteUnits ? ' (bytes de 8 px)' : ''}` });
  if (win.row != null) out.push({ cmd: win.row, data: [...coordBytes(y0, win.coordBytes, win.littleEndian), ...coordBytes(y1, win.coordBytes, win.littleEndian)], desc: `Filas ${y0} a ${y1}` });
  if (win.curX != null) out.push({ cmd: win.curX, data: coordBytes(x0, xCount, win.littleEndian), desc: 'Contador de RAM X al inicio' });
  if (win.curY != null) out.push({ cmd: win.curY, data: coordBytes(y0, win.coordBytes, win.littleEndian), desc: 'Contador de RAM Y al inicio' });
  return out;
}

/** Errores (bloquean) y avisos de un perfil. */
export function checkProfile(profile) {
  const errors = [];
  const warnings = [];
  if (!profile.buses.length) errors.push('Elige al menos una interfaz.');
  const init = parseSequence(profile.init);
  const update = parseSequence(profile.update);
  errors.push(...init.errors.map((e) => `Arranque, ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)}`));
  errors.push(...update.errors.map((e) => `Refresco, ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)}`));
  if (!init.steps.length) warnings.push('La secuencia de arranque está vacía: casi todos los controladores necesitan al menos salir de reposo y encender el display.');
  if (profile.window.mode === 'addr' && profile.window.col == null && profile.window.row == null) warnings.push('El direccionamiento por ventana no tiene comandos de columna ni de fila.');
  if (profile.window.mode !== 'pages' && profile.write == null) warnings.push('Sin comando de escritura de RAM: los datos se enviarán sin un comando previo.');
  if ([...init.steps, ...update.steps].some((s) => s.busy) && !profile.busy) warnings.push('Las secuencias esperan al pin BUSY, pero el perfil no tiene pin BUSY.');
  if (profile.window.mode === 'pages' && profile.pixel.format !== 'mono1-v') warnings.push('El direccionamiento por páginas suele ir con el formato "1 bit, páginas de 8 filas".');
  if (profile.buses.includes('i2c') && profile.dc !== 'i2c' && profile.buses.length === 1) warnings.push('En I2C la señal D/C va en un byte de control: elige "Byte de control I2C".');
  return { errors, warnings, init, update };
}
