/*
  Formatos de píxel nativos de un controlador (lo que viaja por el bus hacia el panel).

  El editor trabaja siempre en RGBA. Para un protocolo propio, encodeNative() convierte
  esa imagen al formato del chip y decodeNative() la reconstruye para la vista previa,
  así lo que ves (grises, bandas de RGB332, tinta de e-paper) es lo que mostraría el panel.
  La conversión coincide bit a bit con la que genera code-export.js en C.
*/

export const NATIVE_FORMATS = [
  { id: 'mono1-h', label: '1 bit, por filas (MSB primero)', bpp: 1, kind: 'mono' },
  { id: 'mono1-hl', label: '1 bit, por filas (LSB primero)', bpp: 1, kind: 'mono' },
  { id: 'mono1-v', label: '1 bit, páginas de 8 filas (bit 0 arriba)', bpp: 1, kind: 'mono' },
  { id: 'gray2', label: '4 grises, 2 bits por píxel', bpp: 2, kind: 'gray' },
  { id: 'gray4', label: '16 grises, 4 bits por píxel', bpp: 4, kind: 'gray' },
  { id: 'rgb332', label: '256 colores, RGB332 (1 byte)', bpp: 8, kind: 'color' },
  { id: 'rgb565', label: '65K colores, RGB565 (2 bytes)', bpp: 16, kind: 'color' },
  { id: 'rgb666', label: '262K colores, RGB666 (3 bytes)', bpp: 24, kind: 'color' },
  { id: 'rgb888', label: '16M colores, RGB888 (3 bytes)', bpp: 24, kind: 'color' },
];

export const formatInfo = (id) => NATIVE_FORMATS.find((f) => f.id === id) ?? NATIVE_FORMATS[6];

/** Luminancia entera 0-255 (la misma fórmula que el C generado). */
export const luma = (r, g, b) => (r * 77 + g * 150 + b * 29) >> 8;

/** Bytes de un frame nativo de w x h. */
export function nativeBytes(format, w, h) {
  switch (format) {
    case 'mono1-h':
    case 'mono1-hl': return Math.ceil(w / 8) * h;
    case 'mono1-v': return w * Math.ceil(h / 8);
    case 'gray2': return Math.ceil(w / 4) * h;
    case 'gray4': return Math.ceil(w / 2) * h;
    case 'rgb332': return w * h;
    case 'rgb565': return w * h * 2;
    default: return w * h * 3;
  }
}

/** Bytes que ocupa una fila (para formatos por filas); null en páginas verticales. */
export function nativeStride(format, w) {
  if (format === 'mono1-v') return null;
  return nativeBytes(format, w, 1);
}

/**
 * Lleva la imagen lógica (ya rotada en el editor) a la orientación nativa del panel.
 * Misma convención que toVerticalPages() del inspector de bus y que el C generado.
 */
export function toNativeOrientation(image, rotation, native) {
  if (!rotation) return image;
  const { width: W, height: H } = native;
  const out = new ImageData(W, H);
  const src = image.data;
  const lw = image.width;
  const from = [
    null,
    (nx, ny) => [ny, W - 1 - nx],
    (nx, ny) => [W - 1 - nx, H - 1 - ny],
    (nx, ny) => [H - 1 - ny, nx],
  ][rotation];
  for (let ny = 0; ny < H; ny++) {
    for (let nx = 0; nx < W; nx++) {
      const [lx, ly] = from(nx, ny);
      const s = (ly * lw + lx) * 4;
      const d = (ny * W + nx) * 4;
      out.data[d] = src[s];
      out.data[d + 1] = src[s + 1];
      out.data[d + 2] = src[s + 2];
      out.data[d + 3] = 255;
    }
  }
  return out;
}

/**
 * RGBA -> bytes nativos.
 * @param pixel { format, bitOn (true: bit 1 = píxel claro, el blanco del editor), bgr, lsbFirst (16 bits: byte bajo primero) }
 */
export function encodeNative(image, pixel) {
  const { width: w, height: h, data } = image;
  const { format, bitOn = true, bgr = false, lsbFirst = false } = pixel;
  const out = new Uint8Array(nativeBytes(format, w, h));
  const rgb = (i) => (bgr ? [data[i + 2], data[i + 1], data[i]] : [data[i], data[i + 1], data[i + 2]]);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = rgb(i);
      const p = y * w + x;
      switch (format) {
        case 'mono1-h':
        case 'mono1-hl':
        case 'mono1-v': {
          const on = (luma(data[i], data[i + 1], data[i + 2]) >= 128) === bitOn;
          if (!on) break;
          if (format === 'mono1-v') out[(y >> 3) * w + x] |= 1 << (y & 7);
          else out[y * Math.ceil(w / 8) + (x >> 3)] |= format === 'mono1-h' ? 0x80 >> (x & 7) : 1 << (x & 7);
          break;
        }
        case 'gray2': {
          let level = luma(data[i], data[i + 1], data[i + 2]) >> 6;
          if (!bitOn) level = 3 - level;
          out[y * Math.ceil(w / 4) + (x >> 2)] |= level << (6 - 2 * (x & 3));
          break;
        }
        case 'gray4': {
          let level = luma(data[i], data[i + 1], data[i + 2]) >> 4;
          if (!bitOn) level = 15 - level;
          out[y * Math.ceil(w / 2) + (x >> 1)] |= level << (x & 1 ? 0 : 4);
          break;
        }
        case 'rgb332':
          out[p] = (r & 0xe0) | ((g >> 3) & 0x1c) | (b >> 6);
          break;
        case 'rgb565': {
          const v = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
          out[p * 2] = lsbFirst ? v & 0xff : v >> 8;
          out[p * 2 + 1] = lsbFirst ? v >> 8 : v & 0xff;
          break;
        }
        case 'rgb666':
          out[p * 3] = r & 0xfc;
          out[p * 3 + 1] = g & 0xfc;
          out[p * 3 + 2] = b & 0xfc;
          break;
        default:
          out[p * 3] = r;
          out[p * 3 + 1] = g;
          out[p * 3 + 2] = b;
      }
    }
  }
  return out;
}

const hexRgb = (hex) => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** Bytes nativos -> RGBA para la vista previa. `on`/`off`: colores del píxel encendido y apagado (mono y grises). */
export function decodeNative(bytes, w, h, pixel, { on = '#ffffff', off = '#000000' } = {}) {
  const { format, bitOn = true, bgr = false, lsbFirst = false } = pixel;
  const image = new ImageData(w, h);
  const onRgb = hexRgb(on);
  const offRgb = hexRgb(off);
  const mix = (t) => offRgb.map((c, k) => Math.round(c + (onRgb[k] - c) * t));
  const d = image.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let c;
      switch (format) {
        case 'mono1-h':
        case 'mono1-hl':
        case 'mono1-v': {
          let bit;
          if (format === 'mono1-v') bit = bytes[(y >> 3) * w + x] & (1 << (y & 7));
          else bit = bytes[y * Math.ceil(w / 8) + (x >> 3)] & (format === 'mono1-h' ? 0x80 >> (x & 7) : 1 << (x & 7));
          c = (Boolean(bit) === bitOn) ? onRgb : offRgb;
          break;
        }
        case 'gray2': {
          let level = (bytes[y * Math.ceil(w / 4) + (x >> 2)] >> (6 - 2 * (x & 3))) & 3;
          if (!bitOn) level = 3 - level;
          c = mix(level / 3);
          break;
        }
        case 'gray4': {
          let level = (bytes[y * Math.ceil(w / 2) + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15;
          if (!bitOn) level = 15 - level;
          c = mix(level / 15);
          break;
        }
        case 'rgb332': {
          const v = bytes[p];
          const r = v & 0xe0;
          const g = (v << 3) & 0xe0;
          const b = (v << 6) & 0xc0;
          c = [r | (r >> 3) | (r >> 6), g | (g >> 3) | (g >> 6), b | (b >> 2) | (b >> 4) | (b >> 6)];
          break;
        }
        case 'rgb565': {
          const v = lsbFirst ? bytes[p * 2] | (bytes[p * 2 + 1] << 8) : (bytes[p * 2] << 8) | bytes[p * 2 + 1];
          const r = (v >> 11) & 31;
          const g = (v >> 5) & 63;
          const b = v & 31;
          c = [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
          break;
        }
        case 'rgb666':
          c = [bytes[p * 3] | (bytes[p * 3] >> 6), bytes[p * 3 + 1] | (bytes[p * 3 + 1] >> 6), bytes[p * 3 + 2] | (bytes[p * 3 + 2] >> 6)];
          break;
        default:
          c = [bytes[p * 3], bytes[p * 3 + 1], bytes[p * 3 + 2]];
      }
      if (bgr && formatInfo(format).kind === 'color') c = [c[2], c[1], c[0]];
      const i = p * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
  return image;
}

/** Vista previa de una imagen tal como la mostraría el panel con ese formato. */
export function nativePreview(image, pixel, colors) {
  return decodeNative(encodeNative(image, pixel), image.width, image.height, pixel, colors);
}
