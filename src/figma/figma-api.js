import { logicalSize } from '../displays/display-configs.js';

/*
  Importación desde Figma por su API REST (token personal, solo lectura): lista los frames
  de un archivo, decide en qué pantallas encajan y los renderiza al tamaño exacto del panel.
*/

const API = 'https://api.figma.com/v1';
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP']);
const CONTAINER_TYPES = new Set(['CANVAS', 'SECTION']);
const MAX_SCALE = 4; // un export 4x de un frame sigue siendo "píxel a píxel"

/**
 * Acepta la URL de un archivo (file/design/proto/board, con o sin rama) o la clave a secas.
 * Devuelve { fileKey, nodeId } con nodeId en formato de la API ("12:34") o null.
 */
export function parseFigmaUrl(input) {
  const text = input.trim();
  if (/^[A-Za-z0-9]{15,}$/.test(text)) return { fileKey: text, nodeId: null };
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  if (!match) return null;
  const node = url.searchParams.get('node-id');
  return { fileKey: match[2] ?? match[1], nodeId: node ? node.replace('-', ':') : null };
}

async function request(path, token) {
  let response;
  try {
    response = await fetch(`${API}${path}`, { headers: { 'X-Figma-Token': token } });
  } catch {
    throw new Error('No se pudo contactar con la API de Figma. Revisa la conexión a internet.');
  }
  if (response.ok) return response.json();
  const detail = await response.json().catch(() => ({}));
  if (response.status === 403) throw new Error('Figma rechazó el token, o no tiene acceso a este archivo. Necesita el permiso "File content: read".');
  if (response.status === 404) throw new Error('No se encontró el archivo o el nodo. Revisa el enlace.');
  if (response.status === 429) throw new Error('Figma limitó las peticiones (demasiadas seguidas). Espera un minuto y vuelve a intentarlo.');
  throw new Error(`Figma respondió ${response.status}${detail.err ? `: ${detail.err}` : ''}.`);
}

/**
 * Prueba el token. Con el permiso "Current user: Read" devuelve { handle }; con solo
 * "File content: Read" Figma responde 403 aunque el token sea válido, así que, si hay un
 * enlace, se prueba además leyendo ese archivo. Devuelve { handle, file } o lanza el error.
 */
export async function testToken(token, url = '') {
  try {
    const me = await request('/me', token);
    return { handle: me.handle ?? me.email ?? '' };
  } catch (error) {
    const target = url && parseFigmaUrl(url);
    if (!target) throw new Error('Figma rechazó el token. Revisa que esté completo; para esta prueba activa también "Current user: Read", o escribe abajo un enlace a un archivo tuyo.');
    const data = await request(`/files/${target.fileKey}?depth=1`, token);
    return { handle: '', file: data.name };
  }
}

/** Frames de primer nivel de un nodo (página o sección), entrando en las secciones. */
function collectFrames(node, page, out) {
  // Orden de lectura en el lienzo (arriba abajo, izquierda a derecha): es el orden de los fotogramas.
  const children = [...(node.children ?? [])].sort((a, b) => {
    const [p, q] = [a.absoluteBoundingBox ?? { x: 0, y: 0 }, b.absoluteBoundingBox ?? { x: 0, y: 0 }];
    return p.y - q.y || p.x - q.x;
  });
  for (const child of children) {
    if (child.visible === false) continue;
    if (CONTAINER_TYPES.has(child.type)) collectFrames(child, page, out);
    else if (FRAME_TYPES.has(child.type) && child.absoluteBoundingBox) {
      const { width, height } = child.absoluteBoundingBox;
      out.push({ id: child.id, name: child.name, page, width: Math.round(width), height: Math.round(height) });
    }
  }
  return out;
}

/**
 * Lee el archivo y devuelve { name, frames: [{ id, name, page, width, height }] }.
 * Con nodeId solo mira ese nodo: si es un frame, ese; si es una página o sección, sus frames.
 */
export async function fetchFrames({ fileKey, nodeId }, token) {
  if (nodeId) {
    const data = await request(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=2`, token);
    const node = data.nodes?.[nodeId]?.document;
    if (!node) throw new Error('El nodo del enlace no existe en el archivo.');
    const frames = FRAME_TYPES.has(node.type) && node.absoluteBoundingBox
      ? collectFrames({ children: [node] }, '', [])
      : collectFrames(node, node.type === 'CANVAS' ? node.name : '', []);
    return { name: data.name, frames };
  }
  const data = await request(`/files/${fileKey}?depth=3`, token);
  const frames = [];
  for (const page of data.document.children ?? []) collectFrames(page, page.name, frames);
  return { name: data.name, frames };
}

/**
 * Pantallas en las que encaja un frame. `exact`: mide lo mismo que el lienzo lógico, o un múltiplo
 * entero (export 2x/3x), en horizontal o girado 90°. Si no, `fit`: proporción parecida (±3 %).
 * Devuelve [{ key, rotation, exact, scale }] con los exactos primero.
 */
export function compatibleDisplays(frame, displays) {
  const matches = [];
  for (const config of displays) {
    const rotations = config.width === config.height ? [0] : [0, 1];
    for (const rotation of rotations) {
      const { width: W, height: H } = logicalSize(config, rotation);
      const k = frame.width / W;
      const exact = Math.abs(frame.width - W * Math.round(k)) <= 1 && Math.abs(frame.height - H * Math.round(k)) <= 1
        && Math.round(k) >= 1 && Math.round(k) <= MAX_SCALE;
      const ratio = (frame.width / frame.height) / (W / H);
      if (exact || Math.abs(ratio - 1) <= 0.03) matches.push({ key: config.key, rotation, exact, scale: W / frame.width });
    }
  }
  return matches.sort((a, b) => b.exact - a.exact);
}

/**
 * Renderiza frames en PNG. `jobs` = [{ id, scale }]; agrupa por escala (la API usa una por
 * petición), descarga cada par frame+escala una sola vez y devuelve los ImageBitmap en el
 * mismo orden que `jobs`.
 */
export async function renderFrames(fileKey, jobs, token, onProgress = () => {}) {
  const norm = (scale) => Math.min(MAX_SCALE, Math.max(0.01, Number(scale.toFixed(4))));
  const byScale = new Map();
  for (const { id, scale } of jobs) {
    const s = norm(scale);
    if (!byScale.has(s)) byScale.set(s, new Set());
    byScale.get(s).add(id);
  }
  const urls = new Map();
  for (const [scale, ids] of byScale) {
    const query = new URLSearchParams({ ids: [...ids].join(','), scale: String(scale), format: 'png', use_absolute_bounds: 'true' });
    const data = await request(`/images/${fileKey}?${query}`, token);
    if (data.err) throw new Error(`Figma no pudo renderizar: ${data.err}`);
    for (const id of ids) {
      if (!data.images?.[id]) throw new Error('Figma no devolvió imagen para uno de los frames (¿está vacío o invisible?).');
      urls.set(`${id}@${scale}`, data.images[id]);
    }
  }
  const bitmaps = new Map();
  for (const [key, url] of urls) {
    const response = await fetch(url).catch(() => null);
    if (!response?.ok) throw new Error('No se pudo descargar la imagen renderizada por Figma.');
    bitmaps.set(key, await createImageBitmap(await response.blob()));
    onProgress(bitmaps.size, urls.size);
  }
  return jobs.map(({ id, scale }) => bitmaps.get(`${id}@${norm(scale)}`));
}
