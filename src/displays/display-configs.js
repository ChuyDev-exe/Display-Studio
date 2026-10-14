import { PIXEL_FORMAT } from '../serial/protocol.js';
import { editorType, kindInfo, makeProfile } from './profile.js';
import { formatInfo } from './native-format.js';

/*
  Cada pantalla pertenece a un controlador, que fija el tipo (texto, mono o color),
  los buses posibles y las resoluciones habituales. Las pantallas se registran en
  DISPLAYS: las integradas al cargar el módulo y las propias desde el modal.
*/
export const CONTROLLERS = Object.freeze({
  custom: {
    label: 'Protocolo propio · cualquier controlador', mode: 'graphic', type: 'tft', group: 'Propias',
    buses: ['spi', 'i2c', '8080'], defaultBus: 'spi', i2cAddr: 0x3c,
    presets: [[240, 240], [240, 320], [128, 64], [128, 296], [200, 200], [250, 122], [296, 128], [400, 300], [320, 480]],
  },
  hd44780: {
    label: 'HD44780 · LCD de caracteres', mode: 'character', group: 'Caracteres',
    buses: ['4bit', '8bit', 'i2c'], defaultBus: 'i2c', i2cAddr: 0x27,
    presets: [[16, 2], [20, 4], [16, 4], [8, 2], [16, 1], [40, 2]],
  },
  ssd1306: {
    label: 'SSD1306 · OLED', mode: 'graphic', type: 'mono', group: 'OLED',
    buses: ['i2c', 'spi'], defaultBus: 'i2c', i2cAddr: 0x3c,
    presets: [[128, 64], [128, 32], [64, 48], [96, 16]], previewOn: '#d7ecff', previewOff: '#05080c',
  },
  sh1106: {
    label: 'SH1106 · OLED 1,3"', mode: 'graphic', type: 'mono', group: 'OLED',
    buses: ['i2c', 'spi'], defaultBus: 'i2c', i2cAddr: 0x3c,
    presets: [[128, 64]], previewOn: '#d7ecff', previewOff: '#05080c',
  },
  pcd8544: {
    label: 'PCD8544 · Nokia 5110', mode: 'graphic', type: 'mono', group: 'Nokia',
    buses: ['spi'], defaultBus: 'spi', presets: [[84, 48]], previewOn: '#1b2a14', previewOff: '#9bb585',
  },
  st7789: {
    label: 'ST7789 · TFT IPS', mode: 'graphic', type: 'tft', group: 'TFT',
    buses: ['spi'], defaultBus: 'spi', presets: [[240, 240], [240, 320], [135, 240], [170, 320]],
  },
  gc9a01: {
    label: 'GC9A01 · TFT redondo', mode: 'graphic', type: 'tft', group: 'TFT', round: true,
    buses: ['spi'], defaultBus: 'spi', presets: [[240, 240]],
  },
  st7735: {
    label: 'ST7735 · TFT pequeño', mode: 'graphic', type: 'tft', group: 'TFT',
    buses: ['spi'], defaultBus: 'spi', presets: [[128, 160], [128, 128], [80, 160]],
  },
  ili9341: {
    label: 'ILI9341 · TFT 2,8"', mode: 'graphic', type: 'tft', group: 'TFT',
    buses: ['spi'], defaultBus: 'spi', presets: [[240, 320]],
  },
});

// Los `id` de las integradas coinciden con displayId del firmware; las propias empiezan en 16.
const BUILT_IN = [
  { key: 'lcd16x2', id: 1, label: 'LCD 16x2', controller: 'hd44780', cols: 16, rows: 2 },
  { key: 'lcd20x4', id: 2, label: 'LCD 20x4', controller: 'hd44780', cols: 20, rows: 4 },
  { key: 'ssd1306', id: 4, label: 'SSD1306', controller: 'ssd1306', width: 128, height: 64 },
  { key: 'nokia5110', id: 3, label: 'Nokia 5110', controller: 'pcd8544', width: 84, height: 48 },
  { key: 'gc9a01', id: 6, label: 'GC9A01', controller: 'gc9a01', width: 240, height: 240 },
  { key: 'st7789', id: 7, label: 'ST7789', controller: 'st7789', width: 240, height: 240 },
];

export const MAX_SIDE = 1024;

export const DISPLAYS = {};
export const DISPLAY_ORDER = [];
export const DEFAULT_DISPLAY = 'gc9a01';
export const ROTATIONS = [0, 1, 2, 3]; // pasos de 90 grados (TFT_eSPI setRotation)

function buildDisplay(spec) {
  if (spec.controller === 'custom') return buildCustom(spec);
  const controller = CONTROLLERS[spec.controller];
  const config = {
    key: spec.key, id: spec.id, label: spec.label, controller: spec.controller, spec,
    custom: Boolean(spec.custom), group: controller.group, mode: controller.mode, touch: spec.touch ?? null,
    buses: controller.buses, defaultBus: controller.defaultBus,
  };
  if (controller.buses.includes('i2c')) config.i2cAddr = spec.i2cAddr ?? controller.i2cAddr;
  if (controller.mode === 'character') {
    Object.assign(config, { cols: spec.cols, rows: spec.rows, format: null });
  } else {
    Object.assign(config, {
      type: controller.type, width: spec.width, height: spec.height,
      format: controller.type === 'mono' ? PIXEL_FORMAT.MONO_1BPP : PIXEL_FORMAT.RGB565_LE,
      round: spec.round ?? Boolean(controller.round),
      previewOn: controller.previewOn, previewOff: controller.previewOff,
    });
  }
  return config;
}

/** Pantalla con protocolo propio: el tipo, los buses y los colores salen de su perfil. */
function buildCustom(spec) {
  const profile = makeProfile(spec.profile);
  const type = editorType(profile);
  const colors = kindInfo(profile.kind);
  const buses = profile.buses.length ? profile.buses : ['spi'];
  return {
    key: spec.key, id: spec.id, label: spec.label, controller: 'custom', spec, profile,
    custom: Boolean(spec.custom), group: 'Propias', mode: 'graphic', buses, defaultBus: buses[0], touch: spec.touch ?? null,
    i2cAddr: profile.i2cAddr, type, width: spec.width, height: spec.height, round: Boolean(spec.round),
    format: type === 'mono' ? PIXEL_FORMAT.MONO_1BPP : PIXEL_FORMAT.RGB565_LE,
    previewOn: colors.on, previewOff: colors.off,
  };
}

export function registerDisplay(spec) {
  const config = buildDisplay(spec);
  if (!DISPLAYS[spec.key]) DISPLAY_ORDER.push(spec.key);
  DISPLAYS[spec.key] = config;
  return config;
}

export function removeDisplay(key) {
  if (!DISPLAYS[key]?.custom) return;
  delete DISPLAYS[key];
  DISPLAY_ORDER.splice(DISPLAY_ORDER.indexOf(key), 1);
}

export function nextDisplayId() {
  return Math.max(15, ...Object.values(DISPLAYS).map((d) => d.id)) + 1;
}

export function slugKey(label) {
  const base = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base || 'pantalla';
}

BUILT_IN.forEach(registerDisplay);

/** Errores (bloquean) y avisos (informan) de una pantalla propia. */
export function validateSpec(spec, editingKey = null) {
  const errors = [];
  const warnings = [];
  const controller = CONTROLLERS[spec.controller];
  if (!spec.label.trim()) errors.push('Escribe un nombre.');
  const key = spec.key ?? slugKey(spec.label);
  if (DISPLAYS[key] && key !== editingKey) errors.push('Ya existe una pantalla con ese nombre.');
  if (Object.values(DISPLAYS).some((d) => d.id === spec.id && d.key !== editingKey)) errors.push(`El ID ${spec.id} ya lo usa otra pantalla.`);
  if (!Number.isInteger(spec.id) || spec.id < 1 || spec.id > 255) errors.push('El ID debe ser un entero de 1 a 255.');

  if (spec.controller === 'custom' && !spec.profile?.buses?.length) errors.push('Elige al menos una interfaz en la pestaña Protocolo.');
  if (controller.mode === 'character') {
    if (!(spec.cols >= 8 && spec.cols <= 40)) errors.push('Columnas: de 8 a 40.');
    if (![1, 2, 4].includes(spec.rows)) errors.push('Filas: 1, 2 o 4.');
  } else {
    if (!(spec.width >= 8 && spec.width <= MAX_SIDE) || !(spec.height >= 8 && spec.height <= MAX_SIDE)) errors.push(`Ancho y alto: de 8 a ${MAX_SIDE} px.`);
    const tft = spec.controller === 'custom' ? editorType(makeProfile(spec.profile)) === 'tft' : controller.type === 'tft';
    const bytes = tft ? spec.width * spec.height * 2 : Math.ceil(spec.width / 8) * spec.height;
    if (bytes > 240 * 240 * 2) warnings.push(`Un frame son ${bytes.toLocaleString('es')} B: el firmware actual solo admite hasta 115.200 B (MAX_FRAME).`);
    if (spec.controller === 'custom') warnings.push('El firmware de ejemplo no conoce este protocolo: el envío por USB se simula y el driver sale en la pestaña Código C.');
    if (spec.touch?.type && spec.touch.bus === 'i2c' && spec.touch.addr == null) warnings.push('Falta la dirección I2C del táctil.');
    if (controller.type === 'mono' && spec.height % 8) warnings.push('Los OLED/Nokia agrupan 8 filas por página: el alto debería ser múltiplo de 8.');
  }
  return { errors, warnings, key };
}

export function formatLabel(config) {
  if (config.mode === 'character') return 'Texto + glifos 5x8';
  if (config.profile) return formatInfo(config.profile.pixel.format).label;
  return config.format === PIXEL_FORMAT.RGB565_LE ? 'RGB565 little-endian' : 'Monocromo 1 bit/píxel';
}

export function resolutionLabel(config) {
  return config.mode === 'character' ? `${config.cols} x ${config.rows} caracteres` : `${config.width} x ${config.height} px`;
}

/** Reloj por defecto del bus: I2C rápido en OLED, 100 kHz en el expansor del LCD, 20 MHz en SPI, 40 MHz en QSPI. */
export function defaultClock(config, bus) {
  if (bus === 'i2c') return config.controller === 'hd44780' ? 100 : 400;
  return { spi: 20, qspi: 40 }[bus] ?? 0;
}

export const BUS_LABELS = Object.freeze({ '4bit': '4 bits', '8bit': '8 bits', i2c: 'I2C', spi: 'SPI', qspi: 'QSPI', 8080: 'Paralelo 8080', rgb: 'RGB paralelo' });
export const CUSTOM_BUSES = ['spi', 'qspi', 'i2c', '8080', 'rgb'];
export const CLOCK_OPTIONS = Object.freeze({ i2c: [100, 400, 1000], spi: [8, 20, 40], qspi: [20, 40, 80] }); // kHz / MHz

/** Tamaño lógico del lienzo: los displays no cuadrados intercambian ancho y alto con 90°/270° (como setRotation). */
export function logicalSize(config, rotation = 0) {
  const swap = rotation % 2 === 1;
  return swap ? { width: config.height, height: config.width } : { width: config.width, height: config.height };
}
