/*
  Generadores de animación para pantallas gráficas. Cada generador dibuja N fotogramas
  a resolución lógica y devuelve ImageData[]. `env` aporta:
    width, height  tamaño lógico del lienzo
    base           ImageData del lienzo actual (o null para fondo negro)
    stamp          { params, render(ctx, params) } del SVG/imagen colocado, o null
*/

import { hardenAlpha, workCanvas } from './crisp.js';

const TAU = Math.PI * 2;

function scratch(env) {
  const canvas = document.createElement('canvas');
  canvas.width = env.width;
  canvas.height = env.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx;
}

/**
 * Crea los fotogramas: fondo (negro o el lienzo actual) + lo que dibuje `paint(ctx, t, k)`.
 * Con `env.crisp` lo dibujado va a una capa aparte que se endurece (sin antialias) antes de
 * componerla: texto y formas llegan al panel con bordes de un píxel, no con halos grises.
 */
function render(env, n, useBase, paint, { hardEdges = env.crisp } = {}) {
  const ctx = scratch(env);
  return Array.from({ length: n }, (_, k) => {
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (useBase && env.base) ctx.putImageData(env.base, 0, 0);
    else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, env.width, env.height);
    }
    const t = n > 1 ? k / (n - 1) : 0;
    if (hardEdges) {
      const { canvas, ctx: layer } = workCanvas('gen-layer', env.width, env.height);
      layer.save();
      paint(layer, t, k);
      layer.restore();
      hardenAlpha(layer, env.width, env.height, 110);
      ctx.drawImage(canvas, 0, 0);
    } else {
      ctx.save();
      paint(ctx, t, k);
      ctx.restore();
    }
    return ctx.getImageData(0, 0, env.width, env.height);
  });
}

const textFont = (size) => `bold ${size}px ui-sans-serif, system-ui, sans-serif`;

export const OBJECT_EFFECTS = [
  ['spin', 'Girar'],
  ['pulse', 'Pulsar'],
  ['slide', 'Deslizar'],
  ['bounce', 'Rebotar'],
  ['blink', 'Parpadear'],
  ['fade', 'Aparecer y desvanecer'],
  ['shake', 'Sacudir'],
  ['orbit', 'Orbitar'],
  ['zoom', 'Acercar'],
];

/** Parámetros del objeto en el paso k de n (t = k / n da un ciclo cerrado para bucles). */
function objectParams(effect, { cx, cy, size, angle }, k, n, env) {
  const t = k / n;
  const p = { cx, cy, size, angle, scale: 1, alpha: 1 };
  if (effect === 'spin') p.angle = angle + TAU * t;
  if (effect === 'pulse') p.scale = 0.7 + 0.3 * Math.sin(TAU * t);
  if (effect === 'slide') p.cx = -size / 2 + (env.width + size) * (k / Math.max(1, n - 1));
  if (effect === 'bounce') p.cy = cy - Math.abs(Math.sin(Math.PI * t)) * env.height * 0.25;
  if (effect === 'blink') p.alpha = k % 2 === 0 ? 1 : 0;
  if (effect === 'fade') p.alpha = 0.5 - 0.5 * Math.cos(TAU * t);
  if (effect === 'shake') p.cx = cx + Math.sin(TAU * t * 4) * size * 0.12;
  if (effect === 'orbit') {
    const radius = Math.min(env.width, env.height) * 0.28;
    p.cx = cx + Math.cos(TAU * t) * radius;
    p.cy = cy + Math.sin(TAU * t) * radius;
  }
  if (effect === 'zoom') p.scale = 0.15 + 0.85 * (k / Math.max(1, n - 1));
  return p;
}

const FRAMES = { id: 'frames', label: 'Fotogramas', type: 'number', min: 2, max: 60 };

export const GENERATORS = [
  {
    id: 'object', group: 'Objeto', label: 'Efecto sobre SVG o imagen', needsStamp: true, defaultFrames: 16, defaultMs: 80, useBase: true,
    fields: [{ id: 'effect', label: 'Efecto', type: 'select', default: 'spin', options: OBJECT_EFFECTS }],
    generate: (v, env, n) => {
      const effect = v.effect === 'blink' ? 'blink' : v.effect;
      const count = effect === 'blink' ? 2 : n;
      // El objeto ya se rasteriza alineado a píxel (drawStamp); endurecer aquí borraría el fundido.
      return render(env, count, true, (ctx, t, k) => env.stamp.render(ctx, objectParams(effect, env.stamp.params, k, count, env)), { hardEdges: false });
    },
  },
  {
    id: 'text-marquee', group: 'Texto', label: 'Texto desplazado', defaultFrames: 40, defaultMs: 50,
    fields: [
      { id: 'text', label: 'Texto', type: 'text', default: 'Hola ESP32' },
      { id: 'size', label: 'Tamaño (px)', type: 'number', default: 16, min: 6, max: 160 },
      { id: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    ],
    generate: (v, env, n) =>
      render(env, n, false, (ctx, t) => {
        ctx.font = textFont(v.size);
        ctx.fillStyle = v.color;
        ctx.textBaseline = 'middle';
        const width = ctx.measureText(v.text).width;
        ctx.fillText(v.text, env.width - (env.width + width) * t, env.height / 2);
      }),
  },
  {
    id: 'text-typewriter', group: 'Texto', label: 'Máquina de escribir', fixedFrames: true, defaultMs: 120,
    fields: [
      { id: 'text', label: 'Texto', type: 'text', default: 'Hola mundo' },
      { id: 'size', label: 'Tamaño (px)', type: 'number', default: 16, min: 6, max: 160 },
      { id: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    ],
    generate: (v, env) => {
      const chars = Array.from(v.text).slice(0, 60);
      return render(env, Math.max(2, chars.length + 1), false, (ctx, t, k) => {
        ctx.font = textFont(v.size);
        ctx.fillStyle = v.color;
        ctx.textBaseline = 'middle';
        const text = chars.slice(0, k).join('');
        ctx.fillText(text + (k % 2 ? '_' : ''), 4, env.height / 2);
      });
    },
  },
  {
    id: 'text-blink', group: 'Texto', label: 'Texto parpadeante', fixedFrames: true, defaultMs: 500,
    fields: [
      { id: 'text', label: 'Texto', type: 'text', default: 'ALERTA' },
      { id: 'size', label: 'Tamaño (px)', type: 'number', default: 24, min: 6, max: 160 },
      { id: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    ],
    generate: (v, env) =>
      render(env, 2, false, (ctx, t, k) => {
        if (k) return;
        ctx.font = textFont(v.size);
        ctx.fillStyle = v.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(v.text, env.width / 2, env.height / 2);
      }),
  },
  {
    id: 'shape-progress', group: 'Formas', label: 'Barra de progreso', defaultFrames: 20, defaultMs: 80,
    fields: [{ id: 'color', label: 'Color', type: 'color', default: '#38bdf8' }],
    generate: (v, env, n) =>
      render(env, n, false, (ctx, t) => {
        const w = env.width * 0.8;
        const h = Math.max(6, env.height * 0.12);
        const x = (env.width - w) / 2;
        const y = (env.height - h) / 2;
        ctx.strokeStyle = v.color;
        ctx.lineWidth = Math.max(1, h * 0.12);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = v.color;
        ctx.fillRect(x + 2, y + 2, Math.max(0, (w - 4) * t), h - 4);
      }),
  },
  {
    id: 'shape-spinner', group: 'Formas', label: 'Spinner circular', defaultFrames: 12, defaultMs: 70,
    fields: [
      { id: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { id: 'thickness', label: 'Grosor (px)', type: 'number', default: 4, min: 1, max: 30 },
    ],
    generate: (v, env, n) =>
      render(env, n, false, (ctx, t, k) => {
        const r = Math.min(env.width, env.height) * 0.32;
        ctx.strokeStyle = v.color;
        ctx.lineWidth = v.thickness;
        ctx.lineCap = 'round';
        const start = (TAU * k) / n;
        ctx.beginPath();
        ctx.arc(env.width / 2, env.height / 2, r, start, start + Math.PI * 1.4);
        ctx.stroke();
      }),
  },
  {
    id: 'shape-bounce', group: 'Formas', label: 'Pelota rebotando', defaultFrames: 24, defaultMs: 50,
    fields: [
      { id: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { id: 'radius', label: 'Radio (px)', type: 'number', default: 6, min: 2, max: 60 },
    ],
    generate: (v, env, n) =>
      render(env, n, false, (ctx, t, k) => {
        const phase = k / n;
        const x = v.radius + (env.width - 2 * v.radius) * (0.5 - 0.5 * Math.cos(TAU * phase));
        const y = env.height - v.radius - Math.abs(Math.sin(TAU * phase * 2)) * (env.height - 2 * v.radius);
        ctx.fillStyle = v.color;
        ctx.beginPath();
        ctx.arc(x, y, v.radius, 0, TAU);
        ctx.fill();
      }),
  },
  {
    id: 'shape-wave', group: 'Formas', label: 'Onda senoidal', defaultFrames: 24, defaultMs: 50,
    fields: [
      { id: 'color', label: 'Color', type: 'color', default: '#34d399' },
      { id: 'cycles', label: 'Ciclos visibles', type: 'number', default: 2, min: 1, max: 8 },
    ],
    generate: (v, env, n) =>
      render(env, n, false, (ctx, t, k) => {
        ctx.strokeStyle = v.color;
        ctx.lineWidth = Math.max(1, Math.round(env.height / 40));
        ctx.beginPath();
        for (let x = 0; x <= env.width; x++) {
          const y = env.height / 2 + Math.sin((x / env.width) * TAU * v.cycles - (TAU * k) / n) * env.height * 0.3;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }),
  },
  {
    id: 'shape-scan', group: 'Formas', label: 'Línea de escaneo', defaultFrames: 20, defaultMs: 40, useBase: true,
    fields: [{ id: 'color', label: 'Color', type: 'color', default: '#38bdf8' }],
    generate: (v, env, n) =>
      render(env, n, true, (ctx, t) => {
        ctx.fillStyle = v.color;
        ctx.fillRect(0, Math.round((env.height - 2) * t), env.width, 2);
      }),
  },
];

export const GENERATOR_GROUPS = ['Objeto', 'Texto', 'Formas'];
export { FRAMES };
