/*
  Conversión de ImageData (RGBA) a los formatos que entiende el ESP32.
  Las funciones decode* reconstruyen la imagen desde el payload para que la
  vista previa muestre exactamente lo que se enviará.
*/

/** RGBA -> RGB565 little-endian (byte bajo primero), 2 bytes por píxel. */
export function rgbaToRgb565LE(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height * 2);
  for (let i = 0, o = 0; i < data.length; i += 4, o += 2) {
    const value = ((data[i] & 0xf8) << 8) | ((data[i + 1] & 0xfc) << 3) | (data[i + 2] >> 3);
    out[o] = value & 0xff;
    out[o + 1] = value >> 8;
  }
  return out;
}

/**
 * RGBA -> bitmap de 1 bit por píxel, row-major, MSB primero.
 * Cada fila se rellena hasta un byte completo: bytesPorFila = ceil(ancho / 8).
 * Bit 1 = píxel encendido (luminancia sobre el umbral).
 */
export function rgbaToMono1bpp(imageData, threshold = 128) {
  const { data, width, height } = imageData;
  const stride = Math.ceil(width / 8);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma >= threshold) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

export function decodeRgb565LE(payload, width, height) {
  const image = new ImageData(width, height);
  for (let p = 0, i = 0; p < payload.length; p += 2, i += 4) {
    const value = payload[p] | (payload[p + 1] << 8);
    const r = (value >> 11) & 0x1f;
    const g = (value >> 5) & 0x3f;
    const b = value & 0x1f;
    image.data[i] = (r << 3) | (r >> 2);
    image.data[i + 1] = (g << 2) | (g >> 4);
    image.data[i + 2] = (b << 3) | (b >> 2);
    image.data[i + 3] = 255;
  }
  return image;
}

export function decodeMono1bpp(payload, width, height, onColor, offColor) {
  const image = new ImageData(width, height);
  const stride = Math.ceil(width / 8);
  const on = hexToRgb(onColor);
  const off = hexToRgb(offColor);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lit = payload[y * stride + (x >> 3)] & (0x80 >> (x & 7));
      const [r, g, b] = lit ? on : off;
      const i = (y * width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  return image;
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
