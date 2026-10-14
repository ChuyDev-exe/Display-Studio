import { loadImage, normalizeSvg } from '../ui/svg-library.js';

/*
  Importación de archivos de imagen: clasificación, decodificación (incluido GIF con
  ImageDecoder), ajuste al lienzo y reducción a 1 bit con tramado para pantallas mono.
*/

export const DITHER_MODES = [
  ['threshold', 'Umbral'],
  ['floyd', 'Floyd–Steinberg'],
  ['bayer', 'Ordenado 4x4'],
];

const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export function fileKind(file) {
  const name = file.name.toLowerCase();
  if (file.type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
  if (file.type === 'image/gif' || name.endsWith('.gif')) return 'gif';
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|avif)$/.test(name)) return 'raster';
  return null;
}

export const gifSupported = () => typeof ImageDecoder !== 'undefined';

/**
 * Convierte un archivo en fuentes dibujables: [{ source, width, height, ms }].
 * Un GIF produce un elemento por fotograma; el resto, uno solo.
 */
export async function decodeFile(file) {
  const kind = fileKind(file);
  if (kind === 'svg') {
    const { svg, ratio } = normalizeSvg(await file.text(), { color: '#ffffff' });
    const image = await loadImage(svg);
    return [{ source: image, width: 512 * Math.min(1, ratio), height: 512 / Math.max(1, ratio), ms: null, kind }];
  }
  if (kind === 'gif' && gifSupported()) {
    const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack.frameCount;
    const frames = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      const bitmap = await createImageBitmap(image);
      frames.push({ source: bitmap, width: bitmap.width, height: bitmap.height, ms: Math.max(20, Math.round((image.duration || 100000) / 1000)), kind });
      image.close();
    }
    decoder.close();
    return frames;
  }
  if (kind) {
    const bitmap = await createImageBitmap(file); // un GIF sin ImageDecoder se queda en su primer fotograma
    return [{ source: bitmap, width: bitmap.width, height: bitmap.height, ms: null, kind }];
  }
  throw new Error(`"${file.name}" no es una imagen compatible (SVG, GIF, PNG, JPG, WebP, BMP).`);
}

/** Dibuja `source` dentro de un lienzo W x H: contener (sin recortar), cubrir (recorta) o estirar. */
export function drawFit(ctx, { source, width, height }, W, H, mode = 'contain') {
  let w = W;
  let h = H;
  if (mode !== 'stretch') {
    const scale = (mode === 'cover' ? Math.max : Math.min)(W / width, H / height);
    w = width * scale;
    h = height * scale;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, (W - w) / 2, (H - h) / 2, w, h);
}

/**
 * Reduce a blanco y negro. Con `masked`, solo procesa los píxeles cubiertos (alfa ≥ 64) y deja
 * el resto transparente: sirve para colocar una imagen sobre un dibujo sin tocar el fondo.
 */
export function dither(imageData, mode = 'threshold', threshold = 128, masked = false) {
  const { data, width, height } = imageData;
  const luma = new Float32Array(width * height);
  const covered = new Uint8Array(width * height);
  for (let p = 0; p < luma.length; p++) {
    const i = p * 4;
    luma[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * (data[i + 3] / 255);
    covered[p] = masked && data[i + 3] < 64 ? 0 : 1;
  }

  if (mode === 'floyd') {
    const spread = (x, y, amount) => {
      const q = y * width + x;
      if (x >= 0 && x < width && y < height && covered[q]) luma[q] += amount;
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!covered[p]) continue;
        const next = luma[p] < threshold ? 0 : 255;
        const error = luma[p] - next;
        luma[p] = next;
        spread(x + 1, y, (error * 7) / 16);
        spread(x - 1, y + 1, (error * 3) / 16);
        spread(x, y + 1, (error * 5) / 16);
        spread(x + 1, y + 1, error / 16);
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      if (!covered[p]) {
        data[i + 3] = 0;
        continue;
      }
      let on;
      if (mode === 'floyd') on = luma[p] >= 128;
      else if (mode === 'bayer') on = luma[p] > ((BAYER_4[y % 4][x % 4] + 0.5) / 16) * 255;
      else on = luma[p] >= threshold;
      data[i] = data[i + 1] = data[i + 2] = on ? 255 : 0;
      data[i + 3] = 255;
    }
  }
  return imageData;
}

/** Dibuja una imagen en una cuadrícula de 5x8 y devuelve las 8 filas de bits de un glifo CGRAM. */
export function imageToGlyph({ source, width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = 5;
  canvas.height = 8;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 5, 8);
  drawFit(ctx, { source, width, height }, 5, 8, 'contain');
  const { data } = ctx.getImageData(0, 0, 5, 8);
  return Array.from({ length: 8 }, (_, row) => {
    let bits = 0;
    for (let col = 0; col < 5; col++) {
      const i = (row * 5 + col) * 4;
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= 110) bits |= 1 << (4 - col);
    }
    return bits;
  });
}
