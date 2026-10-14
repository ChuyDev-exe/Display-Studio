import { hardenAlpha, workCanvas } from '../displays/crisp.js';

/*
  Bibliotecas de SVG instaladas con npm. Vite crea un módulo perezoso por archivo,
  así que solo se descargan los íconos que se muestran o se eligen.
  Para añadir otra biblioteca: `npm i <paquete>` y una entrada más en LIBRARIES.
*/
const lucide = import.meta.glob('/node_modules/lucide-static/icons/*.svg', { query: '?raw', import: 'default' });
const simple = import.meta.glob('/node_modules/simple-icons/icons/*.svg', { query: '?raw', import: 'default' });

export const LIBRARIES = [
  { id: 'lucide', label: 'Lucide (interfaz)', files: lucide },
  { id: 'simple', label: 'Simple Icons (logos)', files: simple },
];

const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1, -4);

export function listIcons(libraryId) {
  const library = LIBRARIES.find((l) => l.id === libraryId);
  return Object.keys(library.files).map((path) => ({ name: nameOf(path), path })).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadIcon(libraryId, path) {
  return LIBRARIES.find((l) => l.id === libraryId).files[path]();
}

/**
 * Prepara un SVG para rasterizar: valida, elimina scripts, fija color/grosor y
 * un tamaño intrínseco grande para que el reescalado sea nítido.
 * @returns {{ svg: string, ratio: number }} ratio = ancho / alto del viewBox
 */
export function normalizeSvg(raw, { color = '#ffffff', strokeWidth = null } = {}) {
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.localName !== 'svg') throw new Error('El contenido no es un SVG válido.');

  svg.querySelectorAll('script, foreignObject').forEach((node) => node.remove());
  [svg, ...svg.querySelectorAll('*')].forEach((node) =>
    [...node.attributes].forEach((a) => a.name.startsWith('on') && node.removeAttribute(a.name)),
  );

  let viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || viewBox.some(Number.isNaN)) {
    const w = parseFloat(svg.getAttribute('width')) || 24;
    const h = parseFloat(svg.getAttribute('height')) || 24;
    viewBox = [0, 0, w, h];
    svg.setAttribute('viewBox', viewBox.join(' '));
  }
  const ratio = viewBox[2] / viewBox[3];

  if (!svg.hasAttribute('fill')) svg.setAttribute('fill', color); // íconos rellenos (Simple Icons)
  if (strokeWidth && svg.hasAttribute('stroke')) svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('width', String(ratio >= 1 ? 512 : Math.round(512 * ratio)));
  svg.setAttribute('height', String(ratio >= 1 ? Math.round(512 / ratio) : 512));
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const markup = new XMLSerializer().serializeToString(svg).replaceAll('currentColor', color);
  return { svg: markup, ratio };
}

export function loadImage(svgMarkup) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('No se pudo dibujar el SVG (¿referencias externas o sintaxis no soportada?).'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
  });
}

const QUARTER = Math.PI / 2;

/**
 * Dibuja `image` centrado en (cx, cy) dentro de un cuadro de `size` px conservando proporción,
 * alineado a la rejilla de píxeles del display:
 *  1. se rasteriza a un tamaño entero exacto (el SVG se dibuja vectorialmente a ese tamaño),
 *  2. con `crisp`, cada píxel queda encendido o apagado (sin halos de antialias),
 *  3. se coloca en una esquina entera; los giros de 90° son exactos (sin remuestreo).
 * Antes se dibujaba en coordenadas fraccionarias con suavizado: en el panel físico eso
 * produce bordes grises a dos píxeles, que es lo que se veía borroso.
 */
export function drawStamp(ctx, image, ratio, { cx, cy, size, angle = 0, scale = 1, alpha = 1, crisp = false }) {
  if (alpha <= 0) return;
  const w = Math.max(1, Math.round((ratio >= 1 ? size : size * ratio) * scale));
  const h = Math.max(1, Math.round((ratio >= 1 ? size / ratio : size) * scale));

  const { canvas: src, ctx: sctx } = workCanvas('stamp-src', w, h);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(image, 0, 0, w, h);
  if (crisp) hardenAlpha(sctx, w, h);

  const turns = angle / QUARTER;
  const quarter = Math.abs(turns - Math.round(turns)) < 1e-6;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (quarter) {
    const k = ((Math.round(turns) % 4) + 4) % 4;
    const bw = k % 2 ? h : w;
    const bh = k % 2 ? w : h;
    const x0 = Math.round(cx - bw / 2);
    const y0 = Math.round(cy - bh / 2);
    ctx.imageSmoothingEnabled = false;
    ctx.translate(x0 + bw / 2, y0 + bh / 2);
    ctx.rotate(k * QUARTER);
    ctx.drawImage(src, -w / 2, -h / 2);
  } else {
    // Ángulo libre (efecto "girar"): se rota sobre otra capa y se vuelve a endurecer.
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const { canvas: layer, ctx: lctx } = workCanvas('stamp-rot', W, H);
    lctx.imageSmoothingEnabled = !crisp;
    lctx.translate(Math.round(cx), Math.round(cy));
    lctx.rotate(angle);
    lctx.drawImage(src, -w / 2, -h / 2);
    if (crisp) hardenAlpha(lctx, W, H, 128);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layer, 0, 0);
  }
  ctx.restore();
}
