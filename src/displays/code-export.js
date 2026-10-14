import { charToCode } from './lcd-editor.js';
import { rgbaToMono1bpp, rgbaToRgb565LE } from './pixel-encoder.js';
import { customDriverFiles } from './driver-export.js';

/*
  Genera el código en C estándar (C99) equivalente al diseño: un .c/.h por objeto (SVG/imagen)
  o por fotograma, la configuración del panel y una tabla que los compone. No depende de ningún
  microcontrolador, framework ni biblioteca: lo único específico de tu hardware son las pocas
  funciones `ui_port_*` (o `lcd_port_*`) que declara ui.h y que implementas con tu driver.
  Son funciones puras: reciben el estado del editor y devuelven archivos
  { name, text, role, bytes?, preview? }. No tocan el DOM.
*/

export const TRANSPARENT_KEY = 0xf81f; // magenta: color "transparente" de los objetos en TFT

const hex = (n, width) => `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;
const kb = (bytes) => `${bytes.toLocaleString('es')} B`;

/** Identificador C válido a partir de un nombre de archivo ("Mi icono.svg" -> "mi_icono"). */
export function slugId(name, taken = new Set()) {
  let base = name.replace(/\.[a-z0-9]+$/i, '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'objeto';
  if (/^\d/.test(base)) base = `img_${base}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

function arrayBody(values, hexWidth, perLine) {
  const lines = [];
  for (let i = 0; i < values.length; i += perLine) {
    const row = [];
    for (let j = i; j < Math.min(i + perLine, values.length); j++) row.push(hex(values[j], hexWidth));
    lines.push(`  ${row.join(', ')},`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------ bitmaps

/** Compone sobre negro: así el borde suavizado se ve igual que en el lienzo. */
function overBlack(image) {
  const out = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  for (let i = 0; i < out.data.length; i += 4) {
    const a = out.data[i + 3] / 255;
    out.data[i] *= a;
    out.data[i + 1] *= a;
    out.data[i + 2] *= a;
    out.data[i + 3] = 255;
  }
  return out;
}

function rgb565Values(image, { transparent = false } = {}) {
  const bytes = rgbaToRgb565LE(overBlack(image));
  const values = new Uint16Array(bytes.length / 2);
  for (let p = 0; p < values.length; p++) {
    let v = bytes[p * 2] | (bytes[p * 2 + 1] << 8);
    if (transparent) {
      if (image.data[p * 4 + 3] < 128) v = TRANSPARENT_KEY;
      else if (v === TRANSPARENT_KEY) v ^= 0x0020; // que un píxel real no se confunda con la clave
    }
    values[p] = v;
  }
  return values;
}

/** Un elemento dibujable: objeto colocado o fotograma completo, ya convertido al formato del display. */
function toAsset(config, { id, label, x, y, image, ms = null }, isObject) {
  const tft = config.type === 'tft';
  const data = tft ? rgb565Values(image, { transparent: isObject }) : rgbaToMono1bpp(overBlack(image));
  return { id, label, x, y, w: image.width, h: image.height, ms, tft, data, bytes: data.length * (tft ? 2 : 1), preview: image, isObject };
}

/** Un bitmap = .h (declaración y medidas) + .c (los datos y su descriptor ui_bitmap_t). */
function assetFiles(asset) {
  const U = asset.id.toUpperCase();
  const type = asset.tft ? 'uint16_t' : 'uint8_t';
  const format = asset.tft ? 'RGB565' : 'monocromo 1 bit/píxel, filas de ceil(w/8) bytes, MSB primero';
  const info = `${asset.label} · ${asset.w}x${asset.h} px · ${format} · ${kb(asset.bytes)}`;
  const h = [
    `/* ${info} */`,
    `#ifndef UI_${U}_H`,
    `#define UI_${U}_H`,
    '',
    '#include "ui.h"',
    '',
    `#define ${U}_W ${asset.w}`,
    `#define ${U}_H ${asset.h}`,
  ];
  if (asset.isObject) h.push(`#define ${U}_X ${asset.x} /* posición en el lienzo */`, `#define ${U}_Y ${asset.y}`);
  h.push('', `extern const ui_bitmap_t ${asset.id};`, '', `#endif /* UI_${U}_H */`, '');
  const c = [
    `/* ${info} */`,
    `#include "${asset.id}.h"`,
    '',
    `static const ${type} ${asset.id}_data[] = {`,
    arrayBody(asset.data, asset.tft ? 4 : 2, asset.tft ? 12 : 16),
    '};',
    '',
    `const ui_bitmap_t ${asset.id} = { ${asset.id}_data, ${asset.w}, ${asset.h}, ${asset.tft ? 'UI_FMT_RGB565' : 'UI_FMT_MONO1'} };`,
    '',
  ];
  return [
    { name: `${asset.id}.h`, role: 'asset', text: h.join('\n'), preview: asset.preview },
    { name: `${asset.id}.c`, role: 'asset', text: c.join('\n'), bytes: asset.bytes, preview: asset.preview },
  ];
}

// ------------------------------------------------------- pantallas gráficas

function uiHeader(config, tft) {
  return `/*
 * ui.h — tipos y funciones que debes implementar para tu pantalla.
 * C99 puro: sin dependencias de microcontrolador, framework ni biblioteca.
 */
#ifndef UI_H
#define UI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define UI_ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

typedef enum {
  UI_FMT_RGB565, /* const uint16_t[w*h], RGB565 en el orden nativo de tu CPU */
  UI_FMT_MONO1   /* const uint8_t[ceil(w/8)*h], MSB primero; bit 1 = píxel encendido */
} ui_format_t;

typedef struct {
  const void *data;
  uint16_t w, h;
  ui_format_t format;
} ui_bitmap_t;

typedef struct {
  const ui_bitmap_t *bitmap;
  int16_t x, y;
} ui_object_t;

typedef struct {
  const ui_bitmap_t *bitmap;
  uint16_t ms; /* tiempo que se muestra el fotograma */
} ui_frame_t;

/* ---- ${config.profile ? 'Implementadas en ui_port.c (generado) sobre el driver del perfil' : `Implementa estas funciones con el driver de tu pantalla (${config.controller.toUpperCase()})`} ---- */

/* Borra el búfer o el panel a negro. */
void ui_port_clear(void);

/* Dibuja un bitmap con su esquina superior izquierda en (x, y).
 * transparent = true: ${tft ? 'los píxeles iguales a UI_TRANSPARENT_KEY no se dibujan.' : 'solo se dibujan los bits en 1; los bits en 0 dejan el fondo intacto.'} */
void ui_port_blit(int16_t x, int16_t y, const ui_bitmap_t *bitmap, bool transparent);

/* Envía el búfer al panel (puede estar vacía si dibujas directamente). */
void ui_port_flush(void);

/* Espera en milisegundos (solo la usan las animaciones). */
void ui_port_delay_ms(uint32_t ms);

#endif /* UI_H */
`;
}

function graphicProject({ config, prefs, mode, frames, loop, objects }) {
  const tft = config.type === 'tft';
  const taken = new Set();
  const assets = mode === 'objects'
    ? objects.map((o) => toAsset(config, { id: slugId(o.name, taken), label: o.name, x: o.x, y: o.y, image: o.image }, true))
    : frames.map((f, i) => toAsset(config, { id: `frame_${String(i + 1).padStart(2, '0')}`, label: `Fotograma ${i + 1}`, x: 0, y: 0, image: f.image, ms: f.ms }, false));

  const animated = mode === 'frames' && assets.length > 1;
  const files = [
    screenFile(),
    { name: 'ui_config.h', role: 'config', text: configFile() },
    { name: 'ui.h', role: 'config', text: uiHeader(config, tft) },
    ...assets.flatMap(assetFiles),
  ];
  if (config.profile) files.splice(1, 0, ...customDriverFiles(config, prefs, slugId(config.profile.name || config.label)));

  const notes = [];
  if (config.profile) notes.push('Protocolo propio: solo implementas drv_port.h (escribir comando/datos en tu bus, esperas y pines). El driver y ui_port.c salen del perfil.');
  if (mode === 'objects' && !assets.length) notes.push('No hay objetos en este fotograma: inserta un SVG o imagen y pulsa «Aplicar al fotograma», o cambia a «Fotogramas completos».');
  if (mode === 'objects') notes.push('Solo se exportan los objetos colocados; lo dibujado a mano con el pincel no es un objeto (usa «Fotogramas completos» para incluirlo).');
  const total = assets.reduce((sum, a) => sum + a.bytes, 0);
  return { files, notes, flash: total };

  function configFile() {
    const { width, height } = frames[0].image;
    const lines = [
      `/* ${config.label} (${config.profile ? config.profile.name || 'protocolo propio' : config.controller.toUpperCase()}) · generado por ESP32 Display Studio */`,
      '#ifndef UI_CONFIG_H',
      '#define UI_CONFIG_H',
      '',
      `#define UI_WIDTH    ${config.width} /* resolución nativa del panel */`,
      `#define UI_HEIGHT   ${config.height}`,
      `#define UI_ROTATION ${prefs.rotation} /* pasos de 90°; el lienzo lógico es ${width}x${height} */`,
      `#define UI_BUS_${prefs.bus.toUpperCase()} 1`,
    ];
    if (prefs.bus === 'i2c') lines.push(`#define UI_I2C_ADDR ${hex(prefs.addr, 2)}`);
    if (prefs.clock) lines.push(`#define UI_BUS_CLOCK_${prefs.bus === 'i2c' ? 'KHZ' : 'MHZ'} ${prefs.clock}`);
    if (config.touch) {
      const t = config.touch;
      lines.push(`#define UI_TOUCH_${t.type === 'cap' ? 'CAPACITIVE' : 'RESISTIVE'} 1 /* ${t.controller === 'other' ? t.name || 'controlador propio' : t.controller.toUpperCase()} por ${t.bus.toUpperCase()} */`);
      if (t.bus === 'i2c' && t.addr != null) lines.push(`#define UI_TOUCH_I2C_ADDR ${hex(t.addr, 2)}`);
      lines.push(`#define UI_TOUCH_POINTS ${t.points ?? 1}`, `#define UI_TOUCH_HAS_INT ${t.int ? 1 : 0}`, `#define UI_TOUCH_HAS_RST ${t.rst ? 1 : 0}`);
    }
    if (tft) lines.push(`#define UI_TRANSPARENT_KEY ${hex(TRANSPARENT_KEY, 4)} /* color que los objetos usan como transparente */`);
    if (animated) lines.push(`#define UI_ANIMATION_LOOP ${loop ? 1 : 0} /* 1: llama a ui_animation_run() en bucle */`);
    lines.push('', '#endif /* UI_CONFIG_H */', '');
    return lines.join('\n');
  }

  function screenFile() {
    const lines = ['#include "ui.h"', '#include "ui_config.h"', ...assets.map((a) => `#include "${a.id}.h"`), ''];
    if (animated) {
      lines.push(
        'static const ui_frame_t frames[] = {',
        ...assets.map((a) => `  { &${a.id}, ${a.ms} },`),
        '};',
        '',
        '/* Reproduce los fotogramas una vez. */',
        'void ui_animation_run(void) {',
        '  for (size_t i = 0; i < UI_ARRAY_LEN(frames); i++) {',
        '    ui_port_blit(0, 0, frames[i].bitmap, false);',
        '    ui_port_flush();',
        '    ui_port_delay_ms(frames[i].ms);',
        '  }',
        '}',
        '',
      );
      return { name: 'ui_screen.c', role: 'source', text: lines.join('\n') };
    }
    if (mode === 'objects' && assets.length) {
      lines.push(
        'static const ui_object_t objects[] = {',
        ...assets.map((a) => `  { &${a.id}, ${a.id.toUpperCase()}_X, ${a.id.toUpperCase()}_Y },`),
        '};',
        '',
      );
    }
    lines.push('/* Dibuja la pantalla completa. */', 'void ui_screen_draw(void) {', '  ui_port_clear();');
    if (mode === 'objects' && assets.length) {
      lines.push('  for (size_t i = 0; i < UI_ARRAY_LEN(objects); i++) {', '    ui_port_blit(objects[i].x, objects[i].y, objects[i].bitmap, true);', '  }');
    } else if (mode === 'frames') {
      lines.push(`  ui_port_blit(0, 0, &${assets[0].id}, false);`);
    }
    lines.push('  ui_port_flush();', '}', '');
    return { name: 'ui_screen.c', role: 'source', text: lines.join('\n') };
  }
}

// ------------------------------------------------------------------- LCD

const LCD_H = `/*
 * lcd_ui.h — funciones que debes implementar para tu LCD de caracteres HD44780.
 * C99 puro: sin dependencias de microcontrolador, framework ni biblioteca.
 */
#ifndef LCD_UI_H
#define LCD_UI_H

#include <stdint.h>

void lcd_port_clear(void);
void lcd_port_set_cursor(uint8_t col, uint8_t row);
void lcd_port_write(uint8_t code);                              /* código de carácter de la ROM o glifo 0-7 */
void lcd_port_create_char(uint8_t slot, const uint8_t rows[8]); /* programa un glifo en la CGRAM */

#define LCD_GLYPH_SLOTS 8

/* Definición de los 8 caracteres personalizados (lcd_glyphs.c). */
extern const uint8_t lcd_glyphs[LCD_GLYPH_SLOTS][8];
void lcd_glyphs_load(void);

/* Dibuja el texto y los glifos colocados (lcd_ui.c). */
void lcd_ui_draw(void);

#endif /* LCD_UI_H */
`;

function lcdProject({ config, prefs, lcd }) {
  // Lo que se ve en pantalla: los glifos guardados y, en el slot activo, el borrador de la cuadrícula.
  const slots = lcd.glyphs.map((rows, slot) => (slot === lcd.slot ? lcd.draft : rows));
  const unsaved = lcd.draft.some((row, i) => row !== lcd.glyphs[lcd.slot][i]);
  const configLines = [
    `/* ${config.label} (HD44780) · generado por ESP32 Display Studio */`,
    '#ifndef LCD_CONFIG_H',
    '#define LCD_CONFIG_H',
    '',
    `#define LCD_COLS ${config.cols}`,
    `#define LCD_ROWS ${config.rows}`,
    `#define LCD_BUS_${prefs.bus.toUpperCase()} 1`,
  ];
  if (prefs.bus === 'i2c') configLines.push(`#define LCD_I2C_ADDR ${hex(prefs.addr, 2)} /* expansor PCF8574 */`);
  configLines.push('', '#endif /* LCD_CONFIG_H */', '');

  const art = (row) => Array.from({ length: 5 }, (_, col) => (row & (1 << (4 - col)) ? '#' : '.')).join('');
  const g = [
    '/* Caracteres personalizados en la CGRAM del HD44780: 8 slots de 5x8 píxeles. */',
    '/* Cada byte es una fila; los 5 bits bajos son las columnas (bit 4 = izquierda). */',
    '#include "lcd_ui.h"',
    '',
    'const uint8_t lcd_glyphs[LCD_GLYPH_SLOTS][8] = {',
  ];
  slots.forEach((rows, slot) => {
    g.push(`  { /* slot ${slot} */`);
    rows.forEach((row, i) => g.push(`    ${hex(row, 2)}, /* ${art(row)} */`.replace(/,( \/\*.*)$/, i === 7 ? '$1' : ',$1')));
    g.push('  },');
  });
  g.push(
    '};', '',
    '/* Programa los 8 slots en el LCD; llámala una vez tras inicializarlo. */',
    'void lcd_glyphs_load(void) {',
    '  for (uint8_t slot = 0; slot < LCD_GLYPH_SLOTS; slot++) lcd_port_create_char(slot, lcd_glyphs[slot]);',
    '}', '',
  );

  const c = ['#include "lcd_ui.h"', '#include "lcd_config.h"', '', '/* Dibuja el texto y los glifos colocados. Llama antes a lcd_glyphs_load(). */', 'void lcd_ui_draw(void) {', '  lcd_port_clear();'];
  lcd.lines.forEach((text, row) => {
    const codes = Array.from(text, (ch) => charToCode(ch) ?? 0x3f);
    while (codes.length && codes[codes.length - 1] === 0x20) codes.pop();
    if (!codes.length) return;
    c.push(`  { static const uint8_t line${row}[] = { ${codes.map((v) => hex(v, 2)).join(', ')} }; /* "${text.trimEnd().replace(/\*\//g, '* /')}" */`,
      `    lcd_port_set_cursor(0, ${row});`,
      `    for (uint8_t i = 0; i < sizeof(line${row}); i++) lcd_port_write(line${row}[i]); }`);
  });
  for (const [key, slot] of lcd.placed) {
    const [col, row] = key.split(',').map(Number);
    c.push(`  lcd_port_set_cursor(${col}, ${row}); lcd_port_write(${slot}); /* glifo CGRAM ${slot} */`);
  }
  c.push('}', '');

  return {
    files: [
      { name: 'lcd_glyphs.c', role: 'source', text: g.join('\n') },
      { name: 'lcd_ui.c', role: 'source', text: c.join('\n') },
      { name: 'lcd_ui.h', role: 'config', text: LCD_H },
      { name: 'lcd_config.h', role: 'config', text: configLines.join('\n') },
    ],
    notes: [
      'El texto y los glifos salen de las pestañas del editor LCD. Las animaciones por fotogramas del LCD no se exportan.',
      ...(unsaved ? [`El slot ${lcd.slot} tiene cambios sin guardar: se exporta el borrador de la cuadrícula.`] : []),
    ],
    flash: 0,
  };
}

/**
 * @param state.config  configuración de la pantalla activa (DISPLAYS[key])
 * @param state.prefs   { rotation, bus, addr, clock }
 * @param state.mode    'objects' | 'frames' (solo pantallas gráficas)
 * @param state.frames  [{ image: ImageData, ms }]
 * @param state.objects [{ name, x, y, image: ImageData }] del fotograma seleccionado
 * @param state.lcd     LcdEditor (pantallas de caracteres)
 */
export function generateProject(state) {
  return state.config.mode === 'character' ? lcdProject(state) : graphicProject(state);
}
