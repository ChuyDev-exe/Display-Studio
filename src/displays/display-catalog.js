import { TEMPLATES, makeProfile } from './profile.js';

/*
  Catálogo para "Agregar pantalla": se elige primero la tecnología (TFT, OLED, e-paper...)
  y después el driver. Un driver con `controller` usa el soporte integrado; el resto se
  describe con una plantilla de protocolo propio (+ `patch`), y "Otro" sirve para cualquier
  chip: parte de la plantilla de su tecnología y se ajusta en Protocolo o con la hoja de datos.
*/

const MIPI_INIT_666 = '01          # SWRESET\ndelay 150\n11          # SLPOUT\ndelay 120\n3A 66       # COLMOD: 18 bits por píxel (en SPI no admite 16)\n36 48       # MADCTL\n29          # DISPON\ndelay 20';

export const TECHS = [
  {
    id: 'tft', label: 'TFT / IPS', desc: 'Color con retroiluminación', kind: 'color', template: 'mipi',
    swatch: ['#2b6cff', '#ff5f6d', '#ffd166'],
    presets: [[240, 240], [240, 320], [135, 240], [170, 320], [128, 160], [320, 480], [480, 480], [800, 480]],
    drivers: [
      { id: 'st7789', label: 'ST7789', controller: 'st7789' },
      { id: 'ili9341', label: 'ILI9341', controller: 'ili9341' },
      { id: 'st7735', label: 'ST7735', controller: 'st7735' },
      { id: 'gc9a01', label: 'GC9A01 (redonda)', controller: 'gc9a01' },
      { id: 'ili9488', label: 'ILI9488', template: 'mipi', presets: [[320, 480]], patch: { pixel: { format: 'rgb666' }, init: MIPI_INIT_666 } },
      { id: 'ili9486', label: 'ILI9486', template: 'mipi', presets: [[320, 480]] },
      { id: 'st7796', label: 'ST7796', template: 'mipi', presets: [[320, 480]] },
      { id: 'hx8357', label: 'HX8357D', template: 'mipi', presets: [[320, 480]] },
      { id: 'ili9342', label: 'ILI9342 (M5Stack)', template: 'mipi', presets: [[320, 240]] },
      { id: 'nv3041a', label: 'NV3041A (QSPI)', template: 'mipi', presets: [[480, 272]], patch: { buses: ['qspi'] } },
      { id: 'st7701', label: 'ST7701S (RGB paralelo)', template: 'mipi', presets: [[480, 480], [480, 854]], patch: { buses: ['rgb'], dc: 'spi9', window: { mode: 'none' }, write: null },
        note: 'Los píxeles salen por el bus RGB (DE, VSYNC, HSYNC, PCLK); el arranque va por SPI de 9 bits.' },
    ],
  },
  {
    id: 'amoled', label: 'AMOLED / OLED color', desc: 'Color sin retroiluminación', kind: 'color', template: 'mipi',
    swatch: ['#000000', '#ff3cac', '#2bd2ff'],
    presets: [[128, 128], [96, 64], [240, 536], [368, 448], [410, 502], [466, 466]],
    drivers: [
      { id: 'ssd1351', label: 'SSD1351', template: 'oledColor', presets: [[128, 128], [128, 96]] },
      { id: 'ssd1331', label: 'SSD1331', template: 'oledColor', presets: [[96, 64]], patch: { write: null } },
      { id: 'rm67162', label: 'RM67162 (QSPI)', template: 'mipi', presets: [[240, 536]], patch: { buses: ['qspi'] } },
      { id: 'sh8601', label: 'SH8601 (QSPI)', template: 'mipi', presets: [[368, 448]], patch: { buses: ['qspi'] } },
      { id: 'co5300', label: 'CO5300 (QSPI)', template: 'mipi', presets: [[466, 466], [410, 502]], patch: { buses: ['qspi'] } },
    ],
  },
  {
    id: 'oled', label: 'OLED monocromo', desc: '1 bit, alto contraste', kind: 'mono', template: 'oledPages',
    swatch: ['#05080c', '#d7ecff'],
    presets: [[128, 64], [128, 32], [64, 48], [72, 40], [128, 128], [64, 128]],
    drivers: [
      { id: 'ssd1306', label: 'SSD1306', controller: 'ssd1306' },
      { id: 'sh1106', label: 'SH1106', controller: 'sh1106' },
      { id: 'ssd1309', label: 'SSD1309', template: 'oledPages', presets: [[128, 64]] },
      { id: 'ssd1305', label: 'SSD1305', template: 'oledPages', presets: [[128, 32], [128, 64]] },
      { id: 'sh1107', label: 'SH1107', template: 'oledPages', presets: [[128, 128], [64, 128]] },
    ],
  },
  {
    id: 'oledGray', label: 'OLED escala de grises', desc: '16 niveles por píxel', kind: 'gray', template: 'oledGray',
    swatch: ['#050505', '#7a7a7a', '#f2f2f2'],
    presets: [[256, 64], [128, 128], [256, 128], [128, 96]],
    drivers: [
      { id: 'ssd1322', label: 'SSD1322', template: 'oledGray', presets: [[256, 64]] },
      { id: 'ssd1327', label: 'SSD1327', template: 'oledGray', presets: [[128, 128]], patch: { write: null } },
      { id: 'ssd1363', label: 'SSD1363', template: 'oledGray', presets: [[256, 128]] },
    ],
  },
  {
    id: 'epaper', label: 'E-paper', desc: 'Tinta electrónica, sin consumo en reposo', kind: 'epaper', template: 'epaperSsd',
    swatch: ['#e7e4dc', '#1d1d1f'],
    presets: [[200, 200], [128, 296], [122, 250], [152, 152], [400, 300], [648, 480], [800, 480]],
    drivers: [
      { id: 'ssd1680', label: 'SSD1680', template: 'epaperSsd', presets: [[128, 296], [122, 250]] },
      { id: 'ssd1681', label: 'SSD1681', template: 'epaperSsd', presets: [[200, 200], [152, 152]] },
      { id: 'ssd1675', label: 'SSD1675', template: 'epaperSsd', presets: [[122, 250]] },
      { id: 'ssd1677', label: 'SSD1677', template: 'epaperSsd', presets: [[800, 480]] },
      { id: 'uc8151', label: 'UC8151 / IL0373', template: 'epaperUc', presets: [[128, 296], [104, 212]] },
      { id: 'uc8176', label: 'UC8176', template: 'epaperUc', presets: [[400, 300]] },
      { id: 'uc8179', label: 'UC8179', template: 'epaperUc', presets: [[800, 480], [648, 480]] },
    ],
  },
  {
    id: 'lcdMono', label: 'LCD gráfico monocromo', desc: 'Nokia, ST7565, ST7920, Sharp memory', kind: 'lcd', template: 'oledPages',
    swatch: ['#9bb585', '#1b2a14'],
    presets: [[84, 48], [128, 64], [128, 128], [400, 240], [144, 168], [102, 64]],
    drivers: [
      { id: 'pcd8544', label: 'PCD8544 (Nokia 5110)', controller: 'pcd8544' },
      { id: 'st7565', label: 'ST7565', template: 'oledPages', presets: [[128, 64]], patch: { dc: 'pin', buses: ['spi'] } },
      { id: 'uc1701', label: 'UC1701', template: 'oledPages', presets: [[128, 64], [102, 64]], patch: { dc: 'pin', buses: ['spi'] } },
      { id: 'st7920', label: 'ST7920', template: 'blank', presets: [[128, 64]], patch: { buses: ['spi', '8080'], pixel: { format: 'mono1-h' } },
        note: 'El ST7920 usa su modo gráfico extendido (34h/36h); revisa las secuencias.' },
      { id: 'ks0108', label: 'KS0108', template: 'oledPages', presets: [[128, 64]], patch: { buses: ['8080'], dc: 'pin' } },
      { id: 'sharp', label: 'Sharp Memory LCD', template: 'blank', presets: [[128, 128], [400, 240], [144, 168]], patch: { buses: ['spi'], pixel: { format: 'mono1-hl' } },
        note: 'Sharp Memory LCD: sin pin D/C; cada línea va con su dirección. Revisa las secuencias.' },
    ],
  },
  {
    id: 'lcdChar', label: 'LCD de caracteres', desc: 'Texto 16x2, 20x4 (HD44780)', character: true,
    swatch: ['#5f7f2a', '#cde47a'],
    presets: [[16, 2], [20, 4], [16, 4], [8, 2], [16, 1], [40, 2]],
    drivers: [
      { id: 'hd44780', label: 'HD44780', controller: 'hd44780' },
      { id: 'st7066', label: 'ST7066 / SPLC780D', controller: 'hd44780' },
      { id: 'aip31068', label: 'AIP31068 (I2C nativo)', controller: 'hd44780' },
    ],
  },
  {
    id: 'other', label: 'Otra', desc: 'Cualquier panel o driver', kind: 'color', template: 'blank',
    swatch: ['#3a3f47', '#7aa7ff'],
    presets: [[240, 240], [128, 64], [320, 240], [480, 320], [800, 480], [1024, 600]],
    drivers: [],
  },
];

export const techInfo = (id) => TECHS.find((t) => t.id === id) ?? TECHS.at(-1);
export const OTHER_DRIVER = 'other';

/** Driver del catálogo o null ("Otro"). */
export const driverInfo = (tech, id) => techInfo(tech).drivers.find((d) => d.id === id) ?? null;

/** Para pantallas guardadas antes del catálogo: deduce tecnología y driver. */
export function inferTech(spec) {
  if (spec.tech) return { tech: spec.tech, driver: spec.driver ?? OTHER_DRIVER };
  if (spec.controller !== 'custom') {
    const tech = TECHS.find((t) => t.drivers.some((d) => d.controller === spec.controller));
    return { tech: tech?.id ?? 'other', driver: tech?.drivers.find((d) => d.controller === spec.controller).id ?? OTHER_DRIVER };
  }
  const kind = spec.profile?.kind;
  const tech = { epaper: 'epaper', gray: 'oledGray' }[kind] ?? 'other';
  return { tech, driver: OTHER_DRIVER };
}

/** Perfil de protocolo propio para un driver del catálogo (o la plantilla de la tecnología si es "Otro"). */
export function driverProfile(techId, driver, kind) {
  const tech = techInfo(techId);
  const base = TEMPLATES[driver?.template ?? tech.template].profile;
  const patch = driver?.patch ?? {};
  return makeProfile({
    ...base, ...patch,
    pixel: { ...base.pixel, ...patch.pixel },
    window: { ...base.window, ...patch.window },
    kind: kind ?? tech.kind ?? base.kind,
  });
}

/** Resoluciones sugeridas: primero las del driver, luego las de la tecnología. */
export function presetsFor(techId, driver) {
  const seen = new Set();
  return [...(driver?.presets ?? []), ...techInfo(techId).presets].filter(([w, h]) => {
    const k = `${w}x${h}`;
    return !seen.has(k) && seen.add(k);
  });
}

// ------------------------------------------------------------------ táctil

export const TOUCH_TYPES = [
  ['none', 'Sin táctil'],
  ['cap', 'Capacitivo'],
  ['res', 'Resistivo'],
];

export const TOUCH_CONTROLLERS = [
  { id: 'ft6x36', label: 'FT6206 / FT6236 / FT6336', type: 'cap', bus: 'i2c', addr: 0x38, points: 2 },
  { id: 'ft5x06', label: 'FT5x06 / FT5436', type: 'cap', bus: 'i2c', addr: 0x38, points: 5 },
  { id: 'gt911', label: 'GT911', type: 'cap', bus: 'i2c', addr: 0x5d, points: 5 },
  { id: 'cst816', label: 'CST816S / CST816T', type: 'cap', bus: 'i2c', addr: 0x15, points: 1 },
  { id: 'cst328', label: 'CST328 / CST226', type: 'cap', bus: 'i2c', addr: 0x1a, points: 5 },
  { id: 'chsc6x', label: 'CHSC6x', type: 'cap', bus: 'i2c', addr: 0x2e, points: 1 },
  { id: 'xpt2046', label: 'XPT2046 / ADS7843', type: 'res', bus: 'spi', addr: null, points: 1 },
  { id: 'tsc2007', label: 'TSC2007', type: 'res', bus: 'i2c', addr: 0x48, points: 1 },
  { id: 'ns2009', label: 'NS2009', type: 'res', bus: 'i2c', addr: 0x48, points: 1 },
  { id: 'stmpe610', label: 'STMPE610', type: 'res', bus: 'spi', addr: null, points: 1 },
  { id: 'other', label: 'Otro', type: null, bus: 'i2c', addr: null, points: 1 },
];

export const touchInfo = (id) => TOUCH_CONTROLLERS.find((t) => t.id === id) ?? TOUCH_CONTROLLERS.at(-1);

/** Configuración táctil por defecto para un tipo. */
export function defaultTouch(type) {
  const c = TOUCH_CONTROLLERS.find((t) => t.type === type);
  return { type, controller: c.id, name: '', bus: c.bus, addr: c.addr, points: c.points, int: true, rst: c.type === 'cap' };
}

/** Texto corto: "Capacitivo · GT911 · I2C 0x5D". */
export function touchLabel(touch) {
  if (!touch) return '';
  const c = touchInfo(touch.controller);
  const name = c.id === 'other' ? touch.name || 'controlador propio' : c.label.split(' / ')[0];
  const addr = touch.bus === 'i2c' && touch.addr != null ? ` 0x${touch.addr.toString(16).toUpperCase().padStart(2, '0')}` : '';
  return `${touch.type === 'cap' ? 'Capacitivo' : 'Resistivo'} · ${name} · ${touch.bus.toUpperCase()}${addr}`;
}
