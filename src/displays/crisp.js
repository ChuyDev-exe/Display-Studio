/*
  Rasterizado "pixel-perfect" para pantallas pequeñas.

  En un display de 240 px cada píxel se ve; los bordes con antialias (píxeles a medio
  cubrir) se convierten en halos grises que en el panel físico parecen desenfoque.
  `hardenAlpha` deja cada píxel totalmente encendido o totalmente transparente.
*/

/** Píxeles con cobertura ≥ umbral pasan a opacos; el resto, a transparente. Conserva el color. */
export function hardenAlpha(ctx, width, height, threshold = 128) {
  if (width <= 0 || height <= 0) return;
  const image = ctx.getImageData(0, 0, width, height);
  const { data } = image;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] >= threshold) data[i] = 255;
    else data[i - 3] = data[i - 2] = data[i - 1] = data[i] = 0;
  }
  ctx.putImageData(image, 0, 0);
}

const pool = new Map();

/** Lienzo auxiliar reutilizable (evita crear uno por fotograma). */
export function workCanvas(id, width, height) {
  let canvas = pool.get(id);
  if (!canvas) {
    canvas = document.createElement('canvas');
    pool.set(id, canvas);
  }
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx };
}
