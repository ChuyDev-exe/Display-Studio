// Íconos SVG inline (trazo, viewBox 24). Sin dependencias ni glifos de texto.
const C = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0z`;

const PATHS = {
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  unplug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4M3 3l18 18',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  trash: 'M4 7h16M9 7V4h6v3M18 7l-1 13H7L6 7M10 11v6M14 11v6',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  eraser: 'M20 20H9l-5-5a2 2 0 0 1 0-3l8-8a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8M8 10l6 6',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: `${C(12, 12, 9)}M12 16v-5M12 8h.01`,
  check: 'M20 6 9 17l-5-5',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  bus: 'M2 12h4l2-6 4 12 3-9 2 3h5',
  chip: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12A9 9 0 0 1 18.5 5.8L21 8M21 3v5h-5M3 21v-5h5',
  rotate: 'M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5',
  close: 'M18 6 6 18M6 6l12 12',
  invert: `${C(12, 12, 9)}M12 3v18`,
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  'chevron-left': 'M15 18l-6-6 6-6',
  'chevron-right': 'M9 18l6-6-6-6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M18 15l-6-6-6 6',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  play: 'M7 4.5v15l12-7.5z',
  stop: 'M7 7h10v10H7z',
  repeat: 'M17 2l4 4-4 4M3 12v-2a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 12v2a4 4 0 0 1-4 4H3',
  image: `M4 4h16v16H4z${C(9, 9, 1.5)}M20 15l-5-5L5 20`,
  shapes: `M3 13h8v8H3z${C(17, 7, 4)}M17 13l4 8h-8z`,
  wand: 'M4 20 15 9M14 4v3M19 9h3M17.5 5.5 19 4M12.5 5.5 11 4M17.5 10.5 19 12',
  film: 'M4 3h16v18H4zM8 3v18M16 3v18M4 8h4M4 16h4M16 8h4M16 16h4M4 12h16',
  maximize: 'M8 3H3v5M21 8V3h-5M3 16v5h5M16 21h5v-5',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  sun: `${C(12, 12, 4)}M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4`,
  type: 'M4 7V4h16v3M9 20h6M12 4v16',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
  pulse: 'M2 17h5V7h10v10h5',
  dot: C(12, 12, 3),
  figma: `M9 3h3v6H9a3 3 0 0 1 0-6zM12 3h3a3 3 0 0 1 0 6h-3zM9 9h3v6H9a3 3 0 0 1 0-6zM15 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6zM9 15h3v3a3 3 0 1 1-3-3z`,
  eye: `M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z${C(12, 12, 3)}`,
  'eye-off': `M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z${C(12, 12, 3)}M3 3l18 18`,
  layers: 'M12 3 2 8l10 5 10-5zM2 16l10 5 10-5M2 12l10 5 10-5',
  sharp: 'M4 4h6v6H4zM10 10h4v4h-4zM14 14h6v6h-6z',
  soft: `${C(12, 12, 8)}`,
};

export function icon(name, classes = 'h-4 w-4') {
  const d = PATHS[name];
  if (!d) throw new Error(`Ícono desconocido: ${name}`);
  return `<svg class="${classes} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
}

/** Logotipo: un display con sus píxeles, dibujado como trazo. */
export function logo(classes = 'h-5 w-5') {
  return `<svg class="${classes} shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <rect x="2.5" y="4.5" width="19" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/>
    <path d="M6 8h2v2H6zM10 8h2v2h-2zM8 10h2v2H8zM14 12h2v2h-2zM16 10h2v2h-2z" fill="currentColor"/>
    <path d="M9 21h6M12 17.5V21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}
