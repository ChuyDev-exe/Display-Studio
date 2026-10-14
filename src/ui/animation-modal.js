import { logicalSize } from '../displays/display-configs.js';
import { frameCost } from '../displays/frame-cost.js';
import { GENERATORS, GENERATOR_GROUPS } from '../displays/graphic-generators.js';
import {
  DITHER_MODES, decodeFile, dither, drawFit, fileKind, gifSupported,
} from '../displays/image-import.js';
import {
  decodeMono1bpp, decodeRgb565LE, rgbaToMono1bpp, rgbaToRgb565LE,
} from '../displays/pixel-encoder.js';
import { PIXEL_FORMAT } from '../serial/protocol.js';
import { createModal, esc } from './modal.js';
import { icon } from './svg-icons.js';

const IMPORT_ID = 'import';

/**
 * Generador de animaciones para pantallas gráficas: efectos sobre el objeto colocado,
 * texto, formas y la importación de GIF / secuencias de imágenes, con vista previa
 * que reproduce lo que realmente mostraría el panel.
 *
 * @param opts.base()   ImageData del lienzo actual
 * @param opts.stamp    { params, render } del objeto colocado, o null
 * @param opts.files    archivos soltados que abren directamente la pestaña de importación
 * @param opts.onApply(items, mode)  items = [{ data, ms }], mode = 'replace' | 'append'
 */
export function openAnimationModal({ config, rotation, base, stamp, files = [], initial, onApply }) {
  const { width, height } = logicalSize(config, rotation);
  const mono = config.type === 'mono';
  const values = {}; // valores de los campos por generador
  const importer = { sources: [], names: [], fit: 'contain', dither: 'floyd', threshold: 128, max: 40, msMode: 'file', ms: 100, notes: [] };
  let selected = initial ?? (files.length ? IMPORT_ID : stamp ? 'object' : 'text-marquee');
  let items = [];
  let timer = 0;
  let regenerate = 0;

  const modal = createModal({ title: 'Generar animación', size: 'max-w-5xl' });
  modal.dialog.addEventListener('close', () => clearTimeout(timer));

  const button = (label, className, handler) => {
    const el = Object.assign(document.createElement('button'), { type: 'button', className: `btn ${className}`, textContent: label });
    el.addEventListener('click', handler);
    return el;
  };
  const appendBtn = button('Agregar al final', '', () => finish('append'));
  appendBtn.classList.add('btn-ghost');
  const replaceBtn = button('Reemplazar fotogramas', 'btn-primary', () => finish('replace'));
  modal.footer.append(button('Cancelar', 'btn-ghost', modal.close), appendBtn, replaceBtn);

  function finish(mode) {
    if (!items.length) return;
    onApply(items, mode);
    modal.close();
  }

  modal.body.innerHTML = `
    <div class="grid gap-4 lg:grid-cols-[10.5rem_minmax(0,1fr)_15rem]">
      <nav data-ref="nav" class="space-y-3 lg:border-r lg:border-ink-600 lg:pr-3" aria-label="Tipo de animación"></nav>
      <div data-ref="form" class="min-w-0 space-y-3"></div>
      <div class="space-y-2">
        <div class="bench grid min-h-[11rem] place-items-center rounded-lg border border-ink-600 p-3">
          <canvas data-ref="preview" class="pixelated block ring-1 ring-ink-500" aria-label="Vista previa de la animación"></canvas>
        </div>
        <p data-ref="info" class="text-[11px] leading-snug text-slate-400" aria-live="polite"></p>
      </div>
    </div>`;
  const $ = (selector) => modal.body.querySelector(selector);

  // ----------------------------------------------------------------- navegación

  function renderNav() {
    const groups = GENERATOR_GROUPS.map((group) => `
      <div><p class="mb-1 px-1 text-2xs font-medium text-slate-500">${group}</p>
        <div class="space-y-1">${GENERATORS.filter((g) => g.group === group).map((g) => navButton(g.id, g.label, g.needsStamp && !stamp)).join('')}</div></div>`).join('');
    $('[data-ref=nav]').innerHTML = `${groups}
      <div><p class="mb-1 px-1 text-2xs font-medium text-slate-500">Archivos</p>${navButton(IMPORT_ID, 'GIF e imágenes')}</div>`;
    $('[data-ref=nav]').querySelectorAll('[data-gen]').forEach((b) => b.addEventListener('click', () => select(b.dataset.gen)));
  }

  function navButton(id, label, disabled = false) {
    return `<button type="button" data-gen="${id}" aria-pressed="${id === selected}" ${disabled ? 'disabled title="Primero inserta un SVG o una imagen en el lienzo"' : ''}
      class="btn btn-ghost !h-auto min-h-7 w-full justify-start !whitespace-normal !px-2 py-1 text-left leading-snug">${esc(label)}</button>`;
  }

  function select(id) {
    selected = id;
    renderNav();
    renderForm();
    schedule();
  }

  // ------------------------------------------------------------------ formulario

  function renderForm() {
    if (selected === IMPORT_ID) return renderImportForm();
    const gen = GENERATORS.find((g) => g.id === selected);
    // Cada generador conserva sus propios valores, también los comunes (fotogramas, duración, fondo).
    values[gen.id] ??= {
      ...Object.fromEntries(gen.fields.map((f) => [f.id, f.default])),
      frames: gen.defaultFrames ?? 16, ms: gen.defaultMs ?? 80, useBase: gen.useBase ?? false, crisp: true,
    };
    const v = values[gen.id];

    $('[data-ref=form]').innerHTML = `
      <h3 class="text-[13px] font-semibold text-white">${esc(gen.label)}</h3>
      <div class="grid gap-3 sm:grid-cols-2">${gen.fields.map((f) => fieldHtml(f, v[f.id])).join('')}
        ${gen.fixedFrames ? '' : fieldHtml({ id: 'frames', label: 'Fotogramas', type: 'number', min: 2, max: 60 }, v.frames)}
        ${fieldHtml({ id: 'ms', label: 'Duración por fotograma (ms)', type: 'number', min: 20, max: 5000 }, v.ms)}
      </div>
      <div class="flex flex-wrap gap-x-5 gap-y-2 pt-1">
        ${'useBase' in gen ? `<label class="flex items-center gap-2 text-xs text-slate-300"><input data-field="useBase" type="checkbox" ${v.useBase ? 'checked' : ''} />Usar el lienzo actual como fondo</label>` : ''}
        ${gen.needsStamp ? '' : `<label class="flex items-center gap-2 text-xs text-slate-300" title="Cada píxel queda encendido o apagado: sin halos grises en el panel"><input data-field="crisp" type="checkbox" ${v.crisp ? 'checked' : ''} />Bordes nítidos</label>`}
      </div>`;
    $('[data-ref=form]').querySelectorAll('[data-field]').forEach((el) => el.addEventListener('input', () => onField(gen, el)));
  }

  function fieldHtml(f, value) {
    const attrs = `data-field="${f.id}" id="f-${f.id}"`;
    let control;
    if (f.type === 'select') {
      control = `<select ${attrs} class="input">${f.options.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    } else if (f.type === 'color') {
      control = `<input ${attrs} type="color" value="${value}" class="swatch !w-full" />`;
    } else {
      control = `<input ${attrs} type="${f.type}" value="${esc(value)}" ${f.min != null ? `min="${f.min}" max="${f.max}"` : ''} class="input" autocomplete="off" />`;
    }
    return `<div><label class="field-label" for="f-${f.id}">${esc(f.label)}</label>${control}</div>`;
  }

  function onField(gen, el) {
    const id = el.dataset.field;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    const v = values[gen.id];
    if (id === 'frames') v.frames = Math.max(2, Math.min(60, value || 2));
    else if (id === 'ms') v.ms = Math.max(20, Math.min(5000, value || 80));
    else v[id] = value;
    schedule();
  }

  // -------------------------------------------------------------- importación

  function renderImportForm() {
    const sel = (id, options, value) => `<select data-imp="${id}" class="input">${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    $('[data-ref=form]').innerHTML = `
      <h3 class="text-[13px] font-semibold text-white">GIF e imágenes</h3>
      <div data-ref="dropzone" class="grid place-items-center gap-2 rounded-lg border border-dashed border-ink-500 p-4 text-center text-xs text-slate-400">
        <p>Suelta aquí un GIF, o varias imágenes (PNG, JPG, WebP, SVG) para usarlas como fotogramas.</p>
        <label class="btn cursor-pointer">${icon('upload', 'h-3.5 w-3.5')}Elegir archivos<input data-ref="files" type="file" multiple accept="image/*,.svg,.gif" class="sr-only" /></label>
        <p data-ref="file-list" class="text-slate-300"></p>
        ${gifSupported() ? '' : '<p class="text-amber-300">Este navegador no puede decodificar GIF animados: se usará solo el primer fotograma.</p>'}
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="field-label">Ajuste al lienzo</label>${sel('fit', [['contain', 'Contener (sin recortar)'], ['cover', 'Cubrir (recorta)'], ['stretch', 'Estirar']], importer.fit)}</div>
        ${mono ? `<div><label class="field-label">Reducción a 1 bit</label>${sel('dither', DITHER_MODES, importer.dither)}</div>
          <div><div class="flex justify-between"><label class="field-label" for="i-th">Umbral</label><output class="text-xs text-slate-400" data-ref="th-out">${importer.threshold}</output></div>
            <input id="i-th" data-imp="threshold" type="range" min="16" max="240" value="${importer.threshold}" class="w-full" /></div>` : ''}
        <div><label class="field-label" for="i-max">Máx. fotogramas</label><input id="i-max" data-imp="max" type="number" min="2" max="120" value="${importer.max}" class="input" /></div>
        <div><label class="field-label">Duración</label>${sel('msMode', [['file', 'La del archivo (GIF)'], ['fixed', 'Fija']], importer.msMode)}</div>
        <div><label class="field-label" for="i-ms">Duración fija (ms)</label><input id="i-ms" data-imp="ms" type="number" min="20" max="5000" value="${importer.ms}" class="input" /></div>
      </div>`;
    updateFileList();
    $('[data-ref=form]').querySelectorAll('[data-imp]').forEach((el) => el.addEventListener('input', () => {
      const key = el.dataset.imp;
      importer[key] = el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
      if (key === 'threshold') $('[data-ref=th-out]').textContent = el.value;
      schedule();
    }));
    $('[data-ref=files]').addEventListener('change', (e) => loadFiles([...e.target.files]));
    const zone = $('[data-ref=dropzone]');
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('border-accent'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('border-accent'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('border-accent');
      loadFiles([...e.dataTransfer.files]);
    });
  }

  function updateFileList() {
    const list = $('[data-ref=file-list]');
    if (!list) return;
    list.innerHTML = importer.names.length
      ? `${importer.names.map(esc).join(', ')} · ${importer.sources.length} fotogramas de origen`
      : 'Ningún archivo cargado.';
    if (importer.notes.length) list.innerHTML += `<br><span class="text-amber-300">${importer.notes.map(esc).join('<br>')}</span>`;
  }

  async function loadFiles(list) {
    const accepted = list.filter((f) => fileKind(f));
    importer.notes = list.filter((f) => !fileKind(f)).map((f) => `"${f.name}" no es una imagen compatible.`);
    importer.sources = [];
    importer.names = accepted.map((f) => f.name);
    $('[data-ref=info]').textContent = 'Decodificando…';
    for (const file of accepted) {
      try {
        importer.sources.push(...await decodeFile(file));
      } catch (error) {
        importer.notes.push(error.message);
      }
    }
    // Un solo archivo sin duración propia (imagen fija) no tiene sentido como animación, pero se permite.
    updateFileList();
    schedule();
  }

  // ------------------------------------------------------------------ generación

  function schedule() {
    clearTimeout(regenerate);
    regenerate = setTimeout(build, 120);
  }

  function build() {
    try {
      items = selected === IMPORT_ID ? buildImport() : buildGenerated();
      $('[data-ref=info]').classList.remove('text-red-300');
    } catch (error) {
      items = [];
      info(error.message, true);
    }
    appendBtn.disabled = replaceBtn.disabled = items.length === 0;
    if (!items.length) {
      clearTimeout(timer);
      return selected === IMPORT_ID && !importer.sources.length ? info('Carga un archivo para ver la vista previa.') : null;
    }
    const cost = frameCost(config, rotation);
    const total = items.reduce((sum, it) => sum + Math.max(it.ms, cost.ms), 0);
    info(`${items.length} fotogramas · ${cost.bytes.toLocaleString('es')} B cada uno · una vuelta ≈ ${(total / 1000).toFixed(1)} s${cost.ms > Math.min(...items.map((i) => i.ms)) ? ' (el USB limita la velocidad)' : ''}.`);
    play();
  }

  function info(text, error = false) {
    const el = $('[data-ref=info]');
    el.textContent = text;
    el.classList.toggle('text-red-300', error);
  }

  function buildGenerated() {
    const gen = GENERATORS.find((g) => g.id === selected);
    if (gen.needsStamp && !stamp) throw new Error('Primero inserta un SVG o una imagen en el lienzo.');
    values[gen.id] ??= {
      ...Object.fromEntries(gen.fields.map((f) => [f.id, f.default])),
      frames: gen.defaultFrames ?? 16, ms: gen.defaultMs ?? 80, useBase: gen.useBase ?? false, crisp: true,
    };
    const v = values[gen.id];
    const env = { width, height, base: v.useBase ? base() : null, stamp, crisp: v.crisp };
    return gen.generate(v, env, gen.fixedFrames ? 0 : v.frames).map((data) => ({ data, ms: v.ms }));
  }

  function buildImport() {
    const { sources } = importer;
    if (!sources.length) return [];
    const count = Math.min(sources.length, Math.max(2, importer.max));
    const picked = sources.length > count ? Array.from({ length: count }, (_, i) => sources[Math.floor((i * sources.length) / count)]) : sources;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return picked.map((src) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      drawFit(ctx, src, width, height, importer.fit);
      let data = ctx.getImageData(0, 0, width, height);
      if (mono) data = dither(data, importer.dither, importer.threshold);
      return { data, ms: importer.msMode === 'file' ? src.ms ?? importer.ms : importer.ms };
    });
  }

  // ---------------------------------------------------------------- vista previa

  const quantize = (image) =>
    config.format === PIXEL_FORMAT.RGB565_LE
      ? decodeRgb565LE(rgbaToRgb565LE(image), width, height)
      : decodeMono1bpp(rgbaToMono1bpp(image), width, height, config.previewOn, config.previewOff);

  function play() {
    clearTimeout(timer);
    const canvas = $('[data-ref=preview]');
    canvas.width = width;
    canvas.height = height;
    const scale = Math.min(224 / width, 168 / height);
    canvas.style.width = `${Math.floor(width * scale)}px`;
    canvas.style.height = `${Math.floor(height * scale)}px`;
    canvas.style.borderRadius = config.round ? '9999px' : '';
    const ctx = canvas.getContext('2d');
    const frames = items.map((it) => ({ image: quantize(it.data), ms: it.ms }));
    let i = 0;
    const tick = () => {
      if (!canvas.isConnected) return;
      ctx.putImageData(frames[i].image, 0, 0);
      timer = setTimeout(tick, Math.max(30, frames[i].ms));
      i = (i + 1) % frames.length;
    };
    tick();
  }

  renderNav();
  renderForm();
  modal.open();
  if (selected === IMPORT_ID && files.length) loadFiles(files);
  else build();
}
