/*
  Traduce un trabajo de alto nivel (comandos JSON o un frame) a las transacciones
  que el ESP32 haría en el bus hacia el controlador: HD44780 en 4/8 bits o I2C
  (expansor PCF8574), SSD1306 en I2C/SPI, PCD8544 (Nokia 5110) y ST7789/GC9A01 en SPI.
  Es una explicación fiel del protocolo del chip, no un volcado del firmware:
  las secuencias de inicio son las habituales de cada controlador.

  Cada fila es { kind, tokens, desc, detail, groupId } y se dibuja con chips en bus-view.js.
*/

import { encodeNative, formatInfo, toNativeOrientation } from './native-format.js';
import { checkProfile, windowCommands } from './profile.js';

const H2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hex = (n) => `0x${H2(n)}`;
const bin = (n, width) => n.toString(2).padStart(width, '0');

// ----------------------------------------------------------------- tokens

export const T = {
  ctl: (text) => ({ t: 'ctl', text }),
  addr: (byte, rw = 'W') => ({ t: 'addr', byte, rw }),
  byte: (v) => ({ t: 'byte', v }),
  sig: (name, value) => ({ t: 'sig', name, value }),
  bits: (name, value, width) => ({ t: 'bits', name, value, width }),
  pulse: (text = 'E') => ({ t: 'pulse', text }),
  more: (n) => ({ t: 'more', n }),
  sep: () => ({ t: 'sep' }),
  bytes: (bytes, max = 16) => [
    ...Array.from(bytes.slice(0, max), (v) => T.byte(v)),
    ...(bytes.length > max ? [T.more(bytes.length - max)] : []),
  ],
};

/** Versión en texto plano de una fila (para copiar al portapapeles). */
export function tokensToText(tokens) {
  return tokens
    .map((k) => {
      switch (k.t) {
        case 'ctl': return k.text;
        case 'addr': return `${hex(k.byte)} ${k.rw}`;
        case 'byte': return H2(k.v);
        case 'sig': return `${k.name}=${k.value}`;
        case 'bits': return `${k.name}=${bin(k.value, k.width)}`;
        case 'pulse': return `${k.text}↑↓`;
        case 'more': return `… +${k.n} B`;
        default: return '·';
      }
    })
    .join(' ');
}

function hexDump(bytes, max = 128) {
  const lines = [];
  for (let i = 0; i < Math.min(bytes.length, max); i += 16) {
    const chunk = Array.from(bytes.slice(i, Math.min(i + 16, max, bytes.length)), H2).join(' ');
    lines.push(`${i.toString(16).toUpperCase().padStart(4, '0')}  ${chunk}`);
  }
  if (bytes.length > max) lines.push(`… ${(bytes.length - max).toLocaleString('es')} bytes más`);
  return lines;
}

class Trace {
  rows = [];
  bits = 0; // bits en un bus serie (I2C/SPI), para estimar el tiempo
  bytes = 0;
  waitMs = 0;
  ops = 0;
  #group = 0;

  group(title) {
    this.#group++;
    this.rows.push({ kind: 'GROUP', tokens: [], desc: title, groupId: this.#group });
  }

  add(kind, tokens, desc, { bits = 0, bytes = 0, detail = [] } = {}) {
    this.rows.push({ kind, tokens, desc, detail, groupId: this.#group });
    this.bits += bits;
    this.bytes += bytes;
    if (kind === 'CMD' || kind === 'DATA') this.ops++;
  }

  wait(ms, text) {
    this.waitMs += ms;
    this.rows.push({ kind: 'WAIT', tokens: [T.ctl(`esperar ${text}`)], desc: '', detail: [], groupId: this.#group });
  }

  info(text) {
    this.rows.push({ kind: 'INFO', tokens: [], desc: text, detail: [], groupId: this.#group });
  }
}

// ------------------------------------------------------------------ HD44780

/** Direcciones DDRAM de cada fila: las filas 3 y 4 continúan a las 1 y 2 (p. ej. 0x14/0x54 en 20 columnas). */
const rowOffsets = (cols, rows) => (rows === 4 ? [0x00, 0x40, cols, 0x40 + cols] : [0x00, 0x40].slice(0, rows));

const charLabel = (code) => {
  if (code < 8) return `glifo CGRAM ${code}`;
  if (code >= 0x20 && code <= 0x7e) return `'${String.fromCharCode(code)}'`;
  return 'carácter ROM';
};

function lcdInit(bus) {
  const eightBit = bus === '8bit';
  const steps = eightBit
    ? [
        { byte: 0x30, desc: 'Function set: modo 8 bits (1/3)', wait: [4.1, '> 4.1 ms'] },
        { byte: 0x30, desc: 'Function set: modo 8 bits (2/3)', wait: [0.1, '> 100 µs'] },
        { byte: 0x30, desc: 'Function set: modo 8 bits (3/3)' },
        { byte: 0x38, desc: 'Function set: 8 bits, 2 líneas, fuente 5x8' },
      ]
    : [
        { byte: 0x30, nibble: true, desc: 'Reset: nibble 0x3 (1/3)', wait: [4.1, '> 4.1 ms'] },
        { byte: 0x30, nibble: true, desc: 'Reset: nibble 0x3 (2/3)', wait: [0.1, '> 100 µs'] },
        { byte: 0x30, nibble: true, desc: 'Reset: nibble 0x3 (3/3)' },
        { byte: 0x20, nibble: true, desc: 'Cambiar a modo 4 bits (nibble 0x2)' },
        { byte: 0x28, desc: 'Function set: 4 bits, 2 líneas, fuente 5x8' },
      ];
  return [
    ...steps,
    { byte: 0x08, desc: 'Display OFF' },
    { byte: 0x01, desc: 'Clear display', wait: [1.6, '1.6 ms'] },
    { byte: 0x06, desc: 'Entry mode: cursor incrementa' },
    { byte: 0x0c, desc: 'Display ON, cursor y parpadeo apagados' },
  ].map((step) => ({ rs: 0, ...step }));
}

/** Convierte comandos JSON en operaciones HD44780 agrupadas, igual que lo haría el firmware. */
function lcdOpsFromCommands(commandList, { cols, rows }) {
  const offsets = rowOffsets(cols, rows);
  const ops = [];
  let group = '';
  const cursor = (col, row) =>
    ops.push({ rs: 0, byte: 0x80 | (offsets[row] + col), desc: `Set DDRAM: fila ${row}, columna ${col}`, group });
  const data = (code, desc = charLabel(code)) => ops.push({ rs: 1, byte: code, desc, group });

  for (const c of commandList) {
    if (c.cmd === 'lcd') {
      group = 'lcd: limpiar pantalla';
      ops.push({ rs: 0, byte: 0x01, desc: 'Clear display (lcd.clear)', wait: [1.6, '1.6 ms'], group });
      for (let row = 0; row < rows; row++) {
        const line = c.lines[row] ?? '';
        if (!line) continue;
        group = `lcd: fila ${row} «${line.trimEnd()}»`;
        cursor(0, row);
        for (let col = 0; col < cols && col < line.length; col++) data(line.charCodeAt(col));
      }
    } else if (c.cmd === 'glyph') {
      group = `glyph: definir slot ${c.slot} en CGRAM`;
      ops.push({ rs: 0, byte: 0x40 | (c.slot << 3), desc: `Set CGRAM: slot ${c.slot}`, group });
      c.rows.forEach((bits, i) => data(bits & 0x1f, `CGRAM slot ${c.slot}, fila ${i}: ${bin(bits & 0x1f, 5)}`));
    } else if (c.cmd === 'glyphAt') {
      group = `glyphAt: slot ${c.slot} en fila ${c.row}, columna ${c.col}`;
      cursor(c.col, c.row);
      data(c.slot);
    } else if (c.cmd === 'lcdRaw') {
      group = `lcdRaw: fila ${c.row}, columna ${c.col} (${c.codes.length} códigos)`;
      cursor(c.col, c.row);
      c.codes.slice(0, cols - c.col).forEach((code) => data(code));
    }
  }
  return ops;
}

function lcdTrace(trace, bus, op, { addr, backlight = true }) {
  const { rs, byte, nibble } = op;
  const hi = byte >> 4;
  const lo = byte & 0x0f;
  const kind = rs ? 'DATA' : 'CMD';
  const desc = `${hex(byte)}  ${op.desc}`;
  const mode = rs ? 'RS=1: registro de DATOS' : 'RS=0: registro de INSTRUCCIÓN';

  if (bus === '8bit') {
    trace.add(kind, [T.sig('RS', rs), T.sig('RW', 0), T.bits('D7..D0', byte, 8), T.pulse()], desc, {
      bytes: 1,
      detail: [mode, 'RW=0: escritura. El LCD captura D7..D0 en el flanco de bajada de E.'],
    });
  } else if (bus === '4bit') {
    const tokens = [T.sig('RS', rs), T.sig('RW', 0), T.bits('D7..D4', hi, 4), T.pulse()];
    if (!nibble) tokens.push(T.sep(), T.bits('D7..D4', lo, 4), T.pulse());
    trace.add(kind, tokens, desc, {
      bytes: nibble ? 1 : 2,
      detail: [
        mode,
        nibble ? `Solo se envía el nibble alto (${bin(hi, 4)}): el LCD aún está en modo 8 bits.`
          : `Primero el nibble alto (${bin(hi, 4)}) y luego el bajo (${bin(lo, 4)}), cada uno con un pulso de E.`,
      ],
    });
  } else {
    // PCF8574: P7..P4 = D7..D4, P3 = backlight, P2 = E, P1 = RW, P0 = RS. Cada nibble: E=1 y luego E=0.
    const bytes = [];
    for (const n of nibble ? [hi] : [hi, lo]) {
      const v = (n << 4) | (backlight ? 0x08 : 0) | rs;
      bytes.push(v | 0x04, v);
    }
    const detail = [mode, 'Cada byte del expansor: P7..P4 = D7..D4 · P3 = luz · P2 = E · P1 = RW · P0 = RS'];
    bytes.forEach((v, i) => {
      detail.push(`${hex(v)} = ${bin(v >> 4, 4)} ${bin(v & 15, 4)}  →  D=${bin(v >> 4, 4)}  BL=${(v >> 3) & 1}  E=${(v >> 2) & 1}  RW=${(v >> 1) & 1}  RS=${v & 1}${i % 2 === 0 ? '   (E sube)' : '   (E baja: el LCD captura el nibble)'}`);
    });
    trace.add(kind, [T.ctl('START'), T.addr(addr << 1), ...T.bytes(bytes), T.ctl('STOP')], desc, {
      bits: (bytes.length + 1) * 9,
      bytes: bytes.length + 1,
      detail,
    });
  }
  if (op.wait) trace.wait(...op.wait);
}

function runLcdOps(trace, bus, ops, ctx) {
  let current = null;
  for (const op of ops) {
    if (op.group && op.group !== current) {
      current = op.group;
      trace.group(current);
    }
    lcdTrace(trace, bus, op, ctx);
  }
}

// ---------------------------------------------------------- bitmap -> páginas

/**
 * Convierte el bitmap lógico (fila a fila, MSB primero) en bancos verticales de 8 píxeles
 * (bit 0 = arriba) en la orientación nativa del panel. `rotation` es la rotación por software
 * (convención de Adafruit_GFX): se invierte para saber qué píxel lógico cae en cada píxel nativo.
 */
function toVerticalPages(payload, logical, native, rotation) {
  const stride = Math.ceil(logical.width / 8);
  const lit = (x, y) =>
    x >= 0 && y >= 0 && x < logical.width && y < logical.height && (payload[y * stride + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
  const { width: W, height: H } = native;
  const source = [
    (nx, ny) => lit(nx, ny),
    (nx, ny) => lit(ny, W - 1 - nx),
    (nx, ny) => lit(W - 1 - nx, H - 1 - ny),
    (nx, ny) => lit(H - 1 - ny, nx),
  ][rotation];

  const pages = [];
  for (let page = 0; page < Math.ceil(H / 8); page++) {
    const bytes = new Uint8Array(W);
    for (let x = 0; x < W; x++) {
      for (let bit = 0; bit < 8; bit++) if (source(x, page * 8 + bit)) bytes[x] |= 1 << bit;
    }
    pages.push(bytes);
  }
  return pages;
}

// ------------------------------------------------------------------ SSD1306

function ssdInit(height) {
  return [
    [[0xae], 'Display OFF'],
    [[0xd5, 0x80], 'Reloj del display / divisor'],
    [[0xa8, height - 1], `Multiplex ratio: ${height} líneas`],
    [[0xd3, 0x00], 'Display offset: 0'],
    [[0x40], 'Start line: 0'],
    [[0x8d, 0x14], 'Charge pump: habilitado'],
    [[0x20, 0x00], 'Modo de direccionamiento horizontal'],
    [[0xa1], 'Segment remap (espejo horizontal)'],
    [[0xc8], 'COM scan invertido'],
    [[0xda, height > 32 ? 0x12 : 0x02], `Configuración de pines COM (${height > 32 ? 'alternativa' : 'secuencial'})`],
    [[0x81, 0xcf], 'Contraste'],
    [[0xd9, 0xf1], 'Pre-charge'],
    [[0xdb, 0x40], 'Nivel VCOMH'],
    [[0xa4], 'Mostrar contenido de la RAM'],
    [[0xa6], 'Display normal (no invertido)'],
    [[0xaf], 'Display ON'],
  ];
}

function ssdCommand(trace, bus, addr, bytes, desc) {
  if (bus === 'i2c') {
    trace.add('CMD', [T.ctl('START'), T.addr(addr << 1), T.byte(0x00), ...T.bytes(bytes), T.ctl('STOP')], desc, {
      bits: (bytes.length + 2) * 9, bytes: bytes.length + 2,
      detail: ['Byte de control 0x00: Co=0, D/C#=0, todo lo que sigue son comandos.'],
    });
  } else {
    trace.add('CMD', [T.ctl('CS↓'), T.sig('DC', 0), ...T.bytes(bytes), T.ctl('CS↑')], desc, {
      bits: bytes.length * 8, bytes: bytes.length, detail: ['DC=0: el SSD1306 interpreta los bytes como comandos.'],
    });
  }
}

function ssdData(trace, bus, addr, page, pageIndex) {
  if (bus === 'i2c') {
    const chunks = Math.ceil(page.length / 16); // el buffer de Wire en ESP32/Arduino admite 32 bytes por transacción
    trace.add('DATA', [T.ctl('START'), T.addr(addr << 1), T.byte(0x40), ...T.bytes(page, 10), T.ctl('STOP'), T.ctl(`×${chunks}`)],
      `Página ${pageIndex}: ${page.length} columnas en ${chunks} transacciones de 16 B`, {
        bits: (page.length + chunks * 2) * 9, bytes: page.length + chunks * 2,
        detail: ['Byte de control 0x40: D/C#=1, lo que sigue es RAM gráfica. Cada byte = 8 píxeles verticales (bit 0 arriba).', ...hexDump(page, 64)],
      });
  } else {
    trace.add('DATA', [T.ctl('CS↓'), T.sig('DC', 1), ...T.bytes(page, 10), T.ctl('CS↑')], `Página ${pageIndex}: ${page.length} columnas`, {
      bits: page.length * 8, bytes: page.length,
      detail: ['DC=1: bytes de RAM gráfica. Cada byte = 8 píxeles verticales (bit 0 arriba).', ...hexDump(page, 64)],
    });
  }
}

// ------------------------------------------------------------------ PCD8544

const PCD_INIT = [
  [0x21, 'Function set: PD=0, H=1 (comandos extendidos)'],
  [0xb8, 'Vop = 0x38 (contraste)'],
  [0x04, 'Coeficiente de temperatura 0'],
  [0x14, 'Bias 1:48'],
  [0x20, 'Function set: H=0 (comandos básicos)'],
  [0x0c, 'Modo normal (no invertido)'],
];

// ------------------------------------------------------------- ST7789 / GC9A01

const TFT = {
  st7735: {
    madctl: [0xc0, 0xa0, 0x00, 0x60],
    init: [
      [0x01, [], 'SWRESET', 150],
      [0x11, [], 'SLPOUT: salir de reposo', 255],
      [0x3a, [0x05], 'COLMOD: 16 bits por píxel (RGB565)'],
      [0x29, [], 'DISPON: encender display', 100],
    ],
    note: 'Resumen: el ST7735 también lleva registros de frecuencia de refresco (0xB1-0xB3), alimentación (0xC0-0xC5) y gamma (0xE0/0xE1).',
  },
  ili9341: {
    madctl: [0x48, 0x28, 0x88, 0xe8],
    init: [
      [0x01, [], 'SWRESET', 5],
      [0x11, [], 'SLPOUT: salir de reposo', 120],
      [0x3a, [0x55], 'COLMOD: 16 bits por píxel (RGB565)'],
      [0x29, [], 'DISPON: encender display'],
    ],
    note: 'Resumen: el ILI9341 completo configura además alimentación (0xC0/0xC1/0xC5/0xC7), frecuencia (0xB1) y gamma positiva/negativa (0xE0/0xE1).',
  },
  st7789: {
    madctl: [0x00, 0x60, 0xc0, 0xa0],
    init: [
      [0x01, [], 'SWRESET', 150],
      [0x11, [], 'SLPOUT: salir de reposo', 120],
      [0x3a, [0x55], 'COLMOD: 16 bits por píxel (RGB565)'],
      [0x21, [], 'INVON: inversión (necesaria en la mayoría de paneles IPS)'],
      [0x13, [], 'NORON: modo normal'],
      [0x29, [], 'DISPON: encender display'],
    ],
  },
  gc9a01: {
    madctl: [0x18, 0x28, 0x48, 0x88],
    init: [
      [0xef, [], 'Inter register enable 2'],
      [0xeb, [0x14], 'Registro de fabricante'],
      [0xfe, [], 'Inter register enable 1'],
      [0xef, [], 'Inter register enable 2'],
      [0x3a, [0x05], 'COLMOD: 16 bits por píxel (RGB565)'],
      [0x21, [], 'INVON: inversión'],
      [0x11, [], 'SLPOUT: salir de reposo', 120],
      [0x29, [], 'DISPON: encender display'],
    ],
    note: 'Resumen: el GC9A01 también necesita ≈ 40 escrituras de registros de fabricante (0x84-0x8F, 0xB0-0xBF, gamma 0xF0-0xF3) que aquí se omiten.',
  },
};

function tftCommand(trace, command, args, desc, waitMs) {
  const tokens = [T.ctl('CS↓'), T.sig('DC', 0), T.byte(command)];
  if (args.length) tokens.push(T.sig('DC', 1), ...T.bytes(args));
  tokens.push(T.ctl('CS↑'));
  trace.add('CMD', tokens, desc, {
    bits: (1 + args.length) * 8, bytes: 1 + args.length,
    detail: ['DC=0 mientras viaja el código de comando; DC=1 para sus parámetros.'],
  });
  if (waitMs) trace.wait(waitMs, `${waitMs} ms`);
}

// ---------------------------------------------------------- protocolo propio

/** Transporte de un comando y sus parámetros según el modo D/C del perfil. */
function customWrite(trace, profile, bus, addr, kind, cmd, data, desc, { detail = [], maxShown = 16 } = {}) {
  const shown = data.slice(0, maxShown);
  const rest = data.length - shown.length;
  const more = rest > 0 ? [T.more(rest)] : [];
  const n = (cmd == null ? 0 : 1) + data.length;
  if (bus === 'i2c') {
    const ctrlCmd = profile.i2cCtrl.cmd;
    const ctrlData = profile.i2cCtrl.data;
    const tokens = [T.ctl('START'), T.addr(addr << 1)];
    if (cmd != null) tokens.push(T.byte(ctrlCmd), T.byte(cmd));
    if (data.length) {
      // En I2C los parámetros de un comando suelen ir como comandos; los datos de RAM, con el byte de datos.
      if (kind === 'DATA') tokens.push(...(cmd != null ? [T.ctl('Sr'), T.addr(addr << 1)] : []), T.byte(ctrlData));
      tokens.push(...T.bytes(shown, maxShown), ...more);
    }
    tokens.push(T.ctl('STOP'));
    trace.add(kind, tokens, desc, {
      bits: (n + 2) * 9, bytes: n + 2,
      detail: [`Byte de control 0x${H2(ctrlCmd)} antes de comandos y 0x${H2(ctrlData)} antes de datos de RAM.`, ...detail],
    });
    return;
  }
  if (bus === 'spi' && profile.dc === 'spi9') {
    const tokens = [T.ctl('CS↓')];
    if (cmd != null) tokens.push(T.bits('D/C', 0, 1), T.byte(cmd));
    if (data.length) tokens.push(T.bits('D/C', 1, 1), ...T.bytes(shown, maxShown), ...more);
    tokens.push(T.ctl('CS↑'));
    trace.add(kind, tokens, desc, { bits: n * 9, bytes: n, detail: ['SPI de 3 hilos: cada byte va precedido de un noveno bit D/C (0 comando, 1 dato).', ...detail] });
    return;
  }
  const parallel = bus === '8080' || bus === 'rgb';
  const strobe = parallel ? [T.pulse(bus === 'rgb' ? 'PCLK' : 'WR')] : [];
  const tokens = [T.ctl('CS↓')];
  if (cmd != null) tokens.push(T.sig('DC', 0), T.byte(cmd), ...strobe);
  if (data.length) tokens.push(T.sig('DC', 1), ...T.bytes(shown, maxShown), ...more, ...strobe);
  tokens.push(T.ctl('CS↑'));
  trace.add(kind, tokens, desc, {
    bits: parallel ? 0 : n * 8, bytes: n,
    detail: [{
      8080: 'Bus paralelo 8080: un byte por flanco de WR, con D/C indicando comando o dato.',
      rgb: 'Bus RGB paralelo: los píxeles salen por las líneas de datos a ritmo de PCLK con DE, HSYNC y VSYNC; los comandos van por un SPI de configuración.',
      qspi: 'QSPI: el comando va en la cabecera de la transacción y los datos por 4 líneas a la vez.',
    }[bus] ?? 'DC=0 mientras viaja el comando; DC=1 para sus parámetros y datos.', ...detail],
  });
}

function customSequence(trace, profile, bus, addr, steps) {
  for (const step of steps) {
    if (step.reset) {
      trace.add('INFO', [T.ctl('RST↓'), T.ctl('RST↑')], `Reset por hardware${step.note ? `: ${step.note}` : ''}`);
      trace.wait(10, '10 ms tras el reset');
    }
    if (step.cmd != null) customWrite(trace, profile, bus, addr, 'CMD', step.cmd, step.data, step.note || `Comando 0x${H2(step.cmd)}`);
    if (step.delay) trace.wait(step.delay, `${step.delay} ms`);
    if (step.busy) {
      trace.rows.push({ kind: 'WAIT', tokens: [T.ctl(`BUSY ${profile.busy === 'low' ? 'bajo' : 'alto'}`)], desc: 'Esperar a que el controlador termine (pin BUSY)', detail: [], groupId: trace.rows.at(-1)?.groupId ?? 0 });
    }
  }
}

function customTrace(trace, config, bus, options, work) {
  const profile = config.profile;
  const { addr = profile.i2cAddr, includeInit } = options;
  const { init, update } = checkProfile(profile);
  const rotation = work.rotation ?? options.rotation ?? 0;
  const hardRotate = profile.rotate?.cmd != null;
  if (includeInit) {
    trace.group(`Inicialización ${profile.name || config.label}`);
    if (!init.steps.length) trace.info('La secuencia de arranque está vacía: complétala en Agregar pantalla, pestaña Secuencias.');
    customSequence(trace, profile, bus, addr, init.steps);
    if (hardRotate) customWrite(trace, profile, bus, addr, 'CMD', profile.rotate.cmd, [profile.rotate.values[rotation] ?? 0], `Rotación ${rotation * 90}° por hardware`);
  }

  if (work.type === 'frame') {
    const native = hardRotate ? { width: work.width, height: work.height } : { width: config.width, height: config.height };
    const image = hardRotate ? work.image : toNativeOrientation(work.image, rotation, native);
    const bytes = encodeNative(image, profile.pixel);
    const fmt = formatInfo(profile.pixel.format);
    const note = !hardRotate && rotation ? ` (rotación por software ${rotation * 90}°)` : '';

    if (profile.window.mode === 'pages') {
      const W = native.width;
      const pages = Math.ceil(native.height / 8);
      for (let p = 0; p < pages; p++) {
        trace.group(`Página ${p} de ${pages}${note}`);
        const col = profile.window.offsetX ?? 0;
        customWrite(trace, profile, bus, addr, 'CMD', profile.window.page | p, [], `Página ${p}`);
        customWrite(trace, profile, bus, addr, 'CMD', profile.window.colLow | (col & 15), [], 'Columna inicial, nibble bajo');
        customWrite(trace, profile, bus, addr, 'CMD', profile.window.colHigh | ((col >> 4) & 15), [], 'Columna inicial, nibble alto');
        const page = bytes.subarray(p * W, (p + 1) * W);
        customWrite(trace, profile, bus, addr, 'DATA', null, Array.from(page), `${W} columnas de 8 píxeles verticales`, { maxShown: 10, detail: hexDump(page, 64) });
      }
    } else {
      const win = windowCommands(profile, native.width, native.height);
      if (win.length) {
        trace.group('Ventana de dibujo');
        win.forEach((c) => customWrite(trace, profile, bus, addr, 'CMD', c.cmd, c.data, c.desc));
      }
      trace.group(`Píxeles${note}`);
      customWrite(trace, profile, bus, addr, 'DATA', profile.write, Array.from(bytes.subarray(0, 64)),
        `${(native.width * native.height).toLocaleString('es')} píxeles, ${fmt.label}: ${bytes.length.toLocaleString('es')} B`, {
          maxShown: 12,
          detail: [`Formato nativo: ${fmt.label}. Bit 1 = píxel ${profile.pixel.bitOn ? 'claro' : 'oscuro'}.`, ...hexDump(bytes, 128)],
        });
      // Ajusta el conteo: arriba solo se pasaron 64 bytes para dibujar los chips.
      const last = trace.rows.at(-1);
      last.tokens = last.tokens.filter((t) => t.t !== 'more');
      if (bytes.length > 12) last.tokens.splice(last.tokens.length - 1, 0, T.more(bytes.length - 12));
      const extra = bytes.length - 64;
      if (extra > 0) {
        trace.bytes += extra;
        trace.bits += bus === 'i2c' ? extra * 9 : bus === 'spi' || bus === 'qspi' ? extra * (profile.dc === 'spi9' ? 9 : 8) : 0;
      }
    }
    if (update.steps.length) {
      trace.group('Refresco del panel');
      customSequence(trace, profile, bus, addr, update.steps);
    }
  } else if (work.type === 'config') {
    trace.group('Configuración');
    if (profile.brightness?.cmd != null) {
      const value = Math.round((work.brightness / 100) * (profile.brightness.max ?? 255));
      customWrite(trace, profile, bus, addr, 'CMD', profile.brightness.cmd, [value], `Brillo ${work.brightness}%`);
    } else {
      trace.info(`Brillo ${work.brightness}%: el perfil no tiene comando de brillo; se controla por PWM en el pin de retroiluminación (o no aplica, como en e-paper).`);
    }
    if (hardRotate) customWrite(trace, profile, bus, addr, 'CMD', profile.rotate.cmd, [profile.rotate.values[work.rotation] ?? 0], `Rotación ${work.rotation * 90}° por hardware`);
    else if (work.rotation) trace.info(`Rotación ${work.rotation * 90}°: el perfil no tiene comando de rotación; el framebuffer se gira por software antes de enviarlo.`);
  }
}

// ------------------------------------------------------------------- entrada

/**
 * @param config   entrada de DISPLAYS
 * @param bus      '4bit' | '8bit' | 'i2c' | 'spi'
 * @param options  { addr, clock (kHz I2C / MHz SPI), includeInit, brightness }
 * @param work     { type: 'lcd', commands } | { type: 'frame', payload, width, height, rotation } | { type: 'config', brightness, rotation }
 * @returns        { rows, summary }
 */
export function busTransactions(config, bus, options, work) {
  const trace = new Trace();
  const { addr = 0x27, clock, includeInit = false } = options;
  const rotation = work.rotation ?? options.rotation ?? 0;

  if (config.profile) {
    customTrace(trace, config, bus, options, work);
  } else if (config.mode === 'character') {
    const ctx = { addr, backlight: options.brightness !== 0 };
    if (includeInit) runLcdOps(trace, bus, lcdInit(bus).map((op) => ({ ...op, group: `Inicialización HD44780 (${bus === '8bit' ? '8 bits' : '4 bits'})` })), ctx);
    if (work.type === 'lcd') {
      runLcdOps(trace, bus, lcdOpsFromCommands(work.commands, config), ctx);
    } else if (work.type === 'config') {
      trace.group('Configuración: retroiluminación');
      if (bus === 'i2c') {
        const byte = work.brightness > 0 ? 0x08 : 0x00;
        trace.add('DATA', [T.ctl('START'), T.addr(addr << 1), T.byte(byte), T.ctl('STOP')],
          `Retroiluminación ${work.brightness > 0 ? 'ON' : 'OFF'}: bit P3 del PCF8574 (solo encendido/apagado)`, { bits: 18, bytes: 2 });
      } else {
        trace.info(`Retroiluminación: pin LED/BK del módulo, PWM al ${work.brightness}% desde un GPIO. No hay tráfico en el bus del LCD.`);
      }
      if (work.rotation) trace.info(`Rotación ${work.rotation * 90}°: el HD44780 no la tiene por hardware ni por comando; solo describe cómo está montado el módulo. No genera tráfico en el bus.`);
    }
  } else if (config.controller === 'ssd1306' || config.controller === 'sh1106') {
    if (includeInit) {
      trace.group(`Inicialización ${config.controller.toUpperCase()}`);
      ssdInit(config.height).forEach(([bytes, desc]) => ssdCommand(trace, bus, addr, bytes, desc));
    }
    if (work.type === 'frame') {
      const soft = rotation % 2 ? rotation : 0; // 180° se hace por hardware con segment remap + COM scan
      const pages = toVerticalPages(work.payload, { width: work.width, height: work.height }, config, soft);
      const note = soft ? ` (rotación por software ${rotation * 90}°)` : '';
      if (config.controller === 'sh1106') {
        // El SH1106 tiene 132 columnas de RAM y solo direccionamiento por página: la ventana se fija en cada página.
        pages.forEach((page, i) => {
          trace.group(`Página ${i} de ${pages.length}${note}`);
          ssdCommand(trace, bus, addr, [0xb0 | i, 0x02, 0x10], `Page ${i} y columna inicial 2 (RAM de 132 columnas)`);
          ssdData(trace, bus, addr, page, i);
        });
      } else {
        trace.group('Ventana de dibujo');
        ssdCommand(trace, bus, addr, [0x21, 0x00, config.width - 1], `Column address: 0 a ${config.width - 1}`);
        ssdCommand(trace, bus, addr, [0x22, 0x00, pages.length - 1], `Page address: 0 a ${pages.length - 1}`);
        trace.group(`Datos: ${pages.length} páginas${note}`);
        pages.forEach((page, i) => ssdData(trace, bus, addr, page, i));
      }
    } else if (work.type === 'config') {
      trace.group('Configuración');
      ssdCommand(trace, bus, addr, [0x81, Math.round(work.brightness * 2.55)], `Contraste ${work.brightness}%`);
      const flip = work.rotation === 2;
      ssdCommand(trace, bus, addr, [flip ? 0xa0 : 0xa1, flip ? 0xc0 : 0xc8], flip ? 'Rotación 180°: segment remap + COM scan' : 'Orientación normal');
      if (work.rotation % 2) trace.info('Este OLED solo gira 0° y 180° por hardware; 90°/270° giran el framebuffer por software antes de enviarlo.');
    }
  } else if (config.controller === 'pcd8544') {
    const cmd = (byte, desc) => trace.add('CMD', [T.ctl('CS↓'), T.sig('DC', 0), T.byte(byte), T.ctl('CS↑')], desc, { bits: 8, bytes: 1 });
    if (includeInit) {
      trace.group('Inicialización PCD8544');
      trace.info('RST↓ ≥ 100 ns y luego RST↑: reset por hardware.');
      PCD_INIT.forEach(([byte, desc]) => cmd(byte, desc));
    }
    if (work.type === 'frame') {
      trace.group('Cursor');
      cmd(0x80, 'Set X = 0');
      cmd(0x40, 'Set Y (banco) = 0');
      trace.group(`Datos: 6 bancos${rotation ? ` (rotación por software ${rotation * 90}°)` : ''}`);
      toVerticalPages(work.payload, { width: work.width, height: work.height }, config, rotation).forEach((bank, i) =>
        trace.add('DATA', [T.ctl('CS↓'), T.sig('DC', 1), ...T.bytes(bank, 10), T.ctl('CS↑')], `Banco ${i}: ${bank.length} columnas`, {
          bits: bank.length * 8, bytes: bank.length,
          detail: ['Cada byte = 8 píxeles verticales (bit 0 arriba).', ...hexDump(bank, 64)],
        }),
      );
    } else if (work.type === 'config') {
      trace.group('Configuración');
      cmd(0x21, 'Comandos extendidos (H=1)');
      cmd(0x80 | (0x30 + Math.round(work.brightness * 0.2)), `Vop (contraste) ${work.brightness}%`);
      cmd(0x20, 'Comandos básicos (H=0)');
      trace.info('Retroiluminación: pin LIGHT del módulo, por GPIO/PWM. El PCD8544 no gira por hardware: se gira el framebuffer.');
    }
  } else {
    const chip = TFT[config.controller];
    if (includeInit) {
      trace.group(`Inicialización ${config.controller.toUpperCase()}`);
      chip.init.forEach(([command, args, desc, waitMs]) => tftCommand(trace, command, args, desc, waitMs));
      tftCommand(trace, 0x36, [chip.madctl[rotation]], `MADCTL: orientación (rotación ${rotation * 90}°)`);
      if (chip.note) trace.info(chip.note);
    }
    if (work.type === 'frame') {
      trace.group('Ventana de dibujo');
      const lastX = work.width - 1;
      const lastY = work.height - 1;
      tftCommand(trace, 0x2a, [0, 0, lastX >> 8, lastX & 255], `CASET: columnas 0 a ${lastX}`);
      tftCommand(trace, 0x2b, [0, 0, lastY >> 8, lastY & 255], `RASET: filas 0 a ${lastY}`);
      trace.group('Píxeles');
      const swapped = new Uint8Array(128);
      for (let i = 0; i < 128; i += 2) {
        swapped[i] = work.payload[i + 1] ?? 0;
        swapped[i + 1] = work.payload[i] ?? 0;
      }
      trace.add('CMD', [T.ctl('CS↓'), T.sig('DC', 0), T.byte(0x2c), T.sig('DC', 1), T.ctl('…')], 'RAMWR: comienza la escritura de píxeles', { bits: 8, bytes: 1 });
      trace.add('DATA', [T.ctl('DC=1'), ...T.bytes(swapped, 12), T.more(work.payload.length - 12), T.ctl('CS↑')],
        `${(work.width * work.height).toLocaleString('es')} píxeles RGB565 · ${work.payload.length.toLocaleString('es')} B`, {
          bits: work.payload.length * 8, bytes: work.payload.length,
          detail: [
            'Por el cable viajan big-endian: el byte alto de cada píxel va primero.',
            'El payload USB es little-endian, así que cada par de bytes se intercambia (setSwapBytes).',
            ...hexDump(swapped, 128),
          ],
        });
    } else if (work.type === 'config') {
      trace.group('Configuración');
      tftCommand(trace, 0x36, [chip.madctl[work.rotation % 4]], `MADCTL: rotación ${work.rotation * 90}°`);
      trace.info(`Brillo ${work.brightness}%: PWM en el pin BLK/LED desde un GPIO. No hay tráfico en el bus SPI.`);
    }
  }

  if (!trace.rows.length) trace.info('Nada que enviar por el bus con la selección actual.');
  return { rows: trace.rows, summary: summarize(trace, bus, clock) };
}

function summarize(trace, bus, clock) {
  const parts = [`${trace.ops} operaciones`, `${trace.bytes.toLocaleString('es')} bytes en el bus`];
  let ms = trace.waitMs;
  if (bus === 'i2c' && clock) ms += (trace.bits / (clock * 1000)) * 1000;
  else if (bus === 'spi' && clock) ms += (trace.bits / (clock * 1_000_000)) * 1000;
  else if (bus === 'qspi' && clock) ms += (trace.bits / (clock * 4_000_000)) * 1000; // 4 líneas de datos
  else if (bus === '8080' || bus === 'rgb') ms += trace.bytes * 0.0001; // ≈ 100 ns por ciclo de escritura
  else ms += trace.ops * 0.04; // HD44780 paralelo: ≈ 37-40 µs por instrucción
  parts.push(`≈ ${ms < 10 ? ms.toFixed(2) : Math.round(ms)} ms`);
  if (trace.waitMs) parts.push(`(incluye ${trace.waitMs.toFixed(1)} ms de esperas)`);
  return parts.join(' · ');
}
