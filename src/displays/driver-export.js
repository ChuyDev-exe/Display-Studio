import { formatInfo, nativeBytes } from './native-format.js';
import { checkProfile, coordBytes } from './profile.js';

/*
  Driver C99 para una pantalla con protocolo propio. Tres archivos:
    drv_port.h   lo único que implementas: escribir comando/datos en tu bus, esperas y pines
    drv_<id>.c/h arranque, ventana, escritura y refresco, sacados del perfil
    ui_port.c    framebuffer en el formato nativo e implementación de ui_port_* (ui.h)
  La conversión de píxeles coincide con native-format.js (la vista previa del editor).
*/

const H2 = (n) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
const cComment = (text) => String(text).replace(/\*\//g, '* /');

function stepsTable(name, steps) {
  if (!steps.length) return [`static const drv_step_t ${name}[] = { { 0, 0, 0, 0, NULL } }; /* vacía */`, `#define ${name.toUpperCase()}_LEN 0`];
  const lines = [];
  steps.forEach((s, i) => {
    if (s.data.length) lines.push(`static const uint8_t ${name}_${i}[] = { ${s.data.map(H2).join(', ')} };`);
  });
  lines.push(`static const drv_step_t ${name}[] = {`);
  steps.forEach((s, i) => {
    const flags = [s.cmd != null ? 'DRV_CMD' : null, s.busy ? 'DRV_BUSY' : null, s.reset ? 'DRV_RESET' : null].filter(Boolean).join(' | ') || '0';
    const data = s.data.length ? `${name}_${i}` : 'NULL';
    lines.push(`  { ${s.cmd != null ? H2(s.cmd) : '0x00'}, ${flags}, ${s.data.length}, ${s.delay}, ${data} },${s.note ? ` /* ${cComment(s.note)} */` : ''}`);
  });
  lines.push('};', `#define ${name.toUpperCase()}_LEN (sizeof(${name}) / sizeof(${name}[0]))`);
  return lines;
}

/** Cuerpo de fb_put(nx, ny, r, g, b) para el formato nativo. */
function putBody(pixel) {
  const { format, bitOn = true, bgr = false, lsbFirst = false } = pixel;
  const swap = bgr && formatInfo(format).kind === 'color' ? '  { uint8_t t = r; r = b; b = t; } /* orden BGR */\n' : '';
  const lum = '  uint8_t lum = (uint8_t)((r * 77u + g * 150u + b * 29u) >> 8);\n';
  switch (format) {
    case 'mono1-h':
    case 'mono1-hl':
    case 'mono1-v': {
      const index = format === 'mono1-v' ? '(size_t)(ny >> 3) * DRV_WIDTH + nx' : '(size_t)ny * DRV_STRIDE + (nx >> 3)';
      const mask = format === 'mono1-v' ? '(uint8_t)(1u << (ny & 7))' : format === 'mono1-h' ? '(uint8_t)(0x80u >> (nx & 7))' : '(uint8_t)(1u << (nx & 7))';
      return `${lum}  bool on = ${bitOn ? '(lum >= 128)' : '(lum < 128)'}; /* bit 1 = píxel ${bitOn ? 'claro' : 'oscuro'} */
  size_t i = ${index};
  uint8_t m = ${mask};
  if (on) fb[i] |= m; else fb[i] &= (uint8_t)~m;`;
    }
    case 'gray2':
      return `${lum}  uint8_t level = ${bitOn ? 'lum >> 6' : '3 - (lum >> 6)'};
  size_t i = (size_t)ny * DRV_STRIDE + (nx >> 2);
  uint8_t shift = (uint8_t)(6 - 2 * (nx & 3));
  fb[i] = (uint8_t)((fb[i] & ~(3u << shift)) | (level << shift));`;
    case 'gray4':
      return `${lum}  uint8_t level = ${bitOn ? 'lum >> 4' : '15 - (lum >> 4)'};
  size_t i = (size_t)ny * DRV_STRIDE + (nx >> 1);
  uint8_t shift = (nx & 1) ? 0 : 4;
  fb[i] = (uint8_t)((fb[i] & ~(15u << shift)) | (level << shift));`;
    case 'rgb332':
      return `${swap}  fb[(size_t)ny * DRV_WIDTH + nx] = (uint8_t)((r & 0xE0) | ((g >> 3) & 0x1C) | (b >> 6));`;
    case 'rgb565':
      return `${swap}  uint16_t v = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
  size_t i = ((size_t)ny * DRV_WIDTH + nx) * 2;
  fb[i] = ${lsbFirst ? '(uint8_t)(v & 0xFF)' : '(uint8_t)(v >> 8)'};
  fb[i + 1] = ${lsbFirst ? '(uint8_t)(v >> 8)' : '(uint8_t)(v & 0xFF)'};`;
    case 'rgb666':
      return `${swap}  size_t i = ((size_t)ny * DRV_WIDTH + nx) * 3;
  fb[i] = r & 0xFC; fb[i + 1] = g & 0xFC; fb[i + 2] = b & 0xFC;`;
    default:
      return `${swap}  size_t i = ((size_t)ny * DRV_WIDTH + nx) * 3;
  fb[i] = r; fb[i + 1] = g; fb[i + 2] = b;`;
  }
}

/** Byte con el que se borra el framebuffer: el fondo del editor (negro, o papel blanco en e-paper). */
function clearByte(profile) {
  const { format, bitOn = true } = profile.pixel;
  const light = profile.kind === 'epaper';
  if (formatInfo(format).kind === 'color') return light ? 0xff : 0x00;
  return light === bitOn ? 0xff : 0x00;
}

export function customDriverFiles(config, prefs, slug) {
  const profile = config.profile;
  const { init, update } = checkProfile(profile);
  const fmt = formatInfo(profile.pixel.format);
  const W = config.width;
  const H = config.height;
  const bytes = nativeBytes(profile.pixel.format, W, H);
  const id = slug;
  const U = id.toUpperCase();
  const win = profile.window;
  const name = cComment(profile.name || config.label);

  const port = `/*
 * drv_port.h — lo único que implementas para ${name}.
 * Bus: ${profile.buses.map((b) => ({ spi: 'SPI', qspi: 'QSPI', i2c: 'I2C', 8080: 'paralelo 8080', rgb: 'RGB paralelo' })[b]).join(' o ')}.
 * ${profile.dc === 'i2c' ? `I2C: antepón el byte de control ${H2(profile.i2cCtrl.cmd)} a los comandos y ${H2(profile.i2cCtrl.data)} a los datos.`
    : profile.dc === 'spi9' ? 'SPI de 9 bits: el noveno bit (primero) es D/C: 0 comando, 1 dato.'
      : 'Pin D/C: bajo durante el comando, alto durante los datos.'}
 */
#ifndef DRV_PORT_H
#define DRV_PORT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void drv_port_write_command(uint8_t cmd);
void drv_port_write_data(const uint8_t *data, size_t len);
void drv_port_delay_ms(uint32_t ms);
${profile.reset ? 'void drv_port_reset(void);   /* pulso bajo en RESET (≥ 10 ms) y espera a que el chip arranque */\n' : ''}${profile.busy ? `bool drv_port_busy(void);   /* true mientras el pin BUSY está ${profile.busy === 'low' ? 'en bajo' : 'en alto'} */\n` : ''}
#endif /* DRV_PORT_H */
`;

  const h = `/* ${name} · ${W}x${H} · ${fmt.label} · generado por ESP32 Display Studio */
#ifndef DRV_${U}_H
#define DRV_${U}_H

#include <stddef.h>
#include <stdint.h>

#define DRV_WIDTH  ${W}
#define DRV_HEIGHT ${H}
#define DRV_FB_BYTES ${bytes} /* framebuffer en el formato nativo */
${fmt.id === 'mono1-v' ? '' : `#define DRV_STRIDE ${nativeBytes(profile.pixel.format, W, 1)} /* bytes por fila */\n`}
void drv_init(void);                         /* arranque completo */
void drv_flush(const uint8_t fb[DRV_FB_BYTES]); /* ventana + escritura de RAM + refresco */
${profile.brightness?.cmd != null ? 'void drv_set_brightness(uint8_t percent);\n' : ''}
#endif /* DRV_${U}_H */
`;

  const winLines = [];
  if (win.mode === 'addr') {
    const byteUnits = win.xUnit === 'byte';
    const xCount = byteUnits ? (win.xBytes ?? 1) : win.coordBytes;
    const x0 = byteUnits ? Math.floor(win.offsetX / 8) : win.offsetX;
    const x1 = byteUnits ? x0 + Math.ceil(W / 8) - 1 : x0 + W - 1;
    const y0 = win.offsetY;
    const y1 = y0 + H - 1;
    const send = (cmd, data, note) => winLines.push(`  { static const uint8_t d[] = { ${data.map(H2).join(', ')} }; drv_port_write_command(${H2(cmd)}); drv_port_write_data(d, sizeof d); } /* ${note} */`);
    if (win.col != null) send(win.col, [...coordBytes(x0, xCount, win.littleEndian), ...coordBytes(x1, xCount, win.littleEndian)], `columnas ${x0}-${x1}${byteUnits ? ' (bytes)' : ''}`);
    if (win.row != null) send(win.row, [...coordBytes(y0, win.coordBytes, win.littleEndian), ...coordBytes(y1, win.coordBytes, win.littleEndian)], `filas ${y0}-${y1}`);
    if (win.curX != null) send(win.curX, coordBytes(x0, xCount, win.littleEndian), 'contador de RAM X');
    if (win.curY != null) send(win.curY, coordBytes(y0, win.coordBytes, win.littleEndian), 'contador de RAM Y');
  }

  const flush = win.mode === 'pages'
    ? `void drv_flush(const uint8_t fb[DRV_FB_BYTES]) {
  for (uint8_t page = 0; page < (DRV_HEIGHT + 7) / 8; page++) {
    drv_port_write_command((uint8_t)(${H2(win.page)} | page));
    drv_port_write_command((uint8_t)(${H2(win.colLow)} | (${win.offsetX ?? 0} & 0x0F)));
    drv_port_write_command((uint8_t)(${H2(win.colHigh)} | ((${win.offsetX ?? 0} >> 4) & 0x0F)));
    drv_port_write_data(fb + (size_t)page * DRV_WIDTH, DRV_WIDTH);
  }
  run(update_seq, UPDATE_SEQ_LEN);
}`
    : `void drv_flush(const uint8_t fb[DRV_FB_BYTES]) {
${winLines.join('\n') || '  /* sin comandos de ventana */'}
${profile.write != null ? `  drv_port_write_command(${H2(profile.write)}); /* escritura de RAM */\n` : ''}  drv_port_write_data(fb, DRV_FB_BYTES);
  run(update_seq, UPDATE_SEQ_LEN);
}`;

  const c = `/* ${name} · ${W}x${H} · ${fmt.label} · generado por ESP32 Display Studio */
#include "drv_${id}.h"
#include "drv_port.h"

#define DRV_CMD   0x01
#define DRV_BUSY  0x02
#define DRV_RESET 0x04

typedef struct {
  uint8_t cmd;
  uint8_t flags;
  uint8_t len;
  uint16_t delay_ms;
  const uint8_t *data;
} drv_step_t;

/* Secuencia de arranque */
${stepsTable('init_seq', init.steps).join('\n')}

/* Refresco después de escribir la RAM */
${stepsTable('update_seq', update.steps).join('\n')}

static void wait_busy(void) {
${profile.busy ? '  while (drv_port_busy()) drv_port_delay_ms(1);' : '  /* el perfil no tiene pin BUSY */'}
}

static void run(const drv_step_t *seq, size_t len) {
  for (size_t i = 0; i < len; i++) {
${profile.reset ? '    if (seq[i].flags & DRV_RESET) drv_port_reset();\n' : ''}    if (seq[i].flags & DRV_CMD) {
      drv_port_write_command(seq[i].cmd);
      if (seq[i].len) drv_port_write_data(seq[i].data, seq[i].len);
    }
    if (seq[i].delay_ms) drv_port_delay_ms(seq[i].delay_ms);
    if (seq[i].flags & DRV_BUSY) wait_busy();
  }
}

void drv_init(void) {
  run(init_seq, INIT_SEQ_LEN);
}

${flush}
${profile.brightness?.cmd != null ? `
void drv_set_brightness(uint8_t percent) {
  uint8_t v = (uint8_t)((percent > 100 ? 100 : percent) * ${profile.brightness.max ?? 255}u / 100u);
  drv_port_write_command(${H2(profile.brightness.cmd)});
  drv_port_write_data(&v, 1);
}
` : ''}`;

  const ui = `/*
 * ui_port.c — implementa ui.h sobre el driver de ${name}.
 * Mantiene un framebuffer en el formato nativo (${fmt.label}) y gira por software
 * según UI_ROTATION. Con esto no hace falta escribir ningún ui_port_* a mano.
 */
#include <string.h>
#include "ui.h"
#include "ui_config.h"
#include "drv_${id}.h"
#include "drv_port.h"

static uint8_t fb[DRV_FB_BYTES];

/* Píxel en coordenadas nativas del panel. */
static void fb_put(int nx, int ny, uint8_t r, uint8_t g, uint8_t b) {
  if (nx < 0 || ny < 0 || nx >= DRV_WIDTH || ny >= DRV_HEIGHT) return;
${putBody(profile.pixel)}
}

/* Píxel en coordenadas lógicas (las del editor) -> nativas. */
static void put(int x, int y, uint8_t r, uint8_t g, uint8_t b) {
#if UI_ROTATION == 1
  fb_put(DRV_WIDTH - 1 - y, x, r, g, b);
#elif UI_ROTATION == 2
  fb_put(DRV_WIDTH - 1 - x, DRV_HEIGHT - 1 - y, r, g, b);
#elif UI_ROTATION == 3
  fb_put(y, DRV_HEIGHT - 1 - x, r, g, b);
#else
  fb_put(x, y, r, g, b);
#endif
}

void ui_port_clear(void) {
  memset(fb, ${H2(clearByte(profile))}, sizeof fb); /* ${profile.kind === 'epaper' ? 'papel en blanco' : 'negro'} */
}

void ui_port_blit(int16_t x, int16_t y, const ui_bitmap_t *bm, bool transparent) {
  for (uint16_t row = 0; row < bm->h; row++) {
    for (uint16_t col = 0; col < bm->w; col++) {
      uint8_t r, g, b;
      if (bm->format == UI_FMT_RGB565) {
        uint16_t v = ((const uint16_t *)bm->data)[(size_t)row * bm->w + col];
#ifdef UI_TRANSPARENT_KEY
        if (transparent && v == UI_TRANSPARENT_KEY) continue;
#endif
        r = (uint8_t)(((v >> 11) & 31) << 3);
        g = (uint8_t)(((v >> 5) & 63) << 2);
        b = (uint8_t)((v & 31) << 3);
      } else {
        const uint8_t *bits = (const uint8_t *)bm->data;
        bool on = (bits[(size_t)row * ((bm->w + 7) / 8) + (col >> 3)] & (0x80 >> (col & 7))) != 0;
        if (transparent && !on) continue;
        r = g = b = on ? 255 : 0;
      }
      put(x + col, y + row, r, g, b);
    }
  }
}

void ui_port_flush(void) {
  drv_flush(fb);
}

void ui_port_delay_ms(uint32_t ms) {
  drv_port_delay_ms(ms);
}
`;

  return [
    { name: `drv_${id}.c`, role: 'source', text: c },
    { name: 'ui_port.c', role: 'source', text: ui },
    { name: `drv_${id}.h`, role: 'config', text: h },
    { name: 'drv_port.h', role: 'config', text: port },
  ];
}
