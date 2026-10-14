/*
  Lector local de hojas de datos y manuales de referencia de controladores de pantalla.

  Todo ocurre en el navegador: el PDF se lee con pdf.js (sin enviar nada a internet),
  se reconstruyen las líneas de texto por posición y se buscan con patrones:
  controlador, resolución, interfaces, dirección I2C, profundidad de color y la tabla
  de comandos (código hexadecimal + nombre). Con eso se propone un perfil de protocolo
  que el usuario revisa campo por campo antes de aplicarlo.
*/

import { TEMPLATES, makeProfile, stepLine } from './profile.js';
import { formatInfo } from './native-format.js';

const MAX_PAGES = 400;

// ------------------------------------------------------------- extracción

/** Lee un PDF o un texto y devuelve { name, pages: string[][] } (líneas por página). */
export async function readDatasheet(file, onProgress = () => {}) {
  const name = file.name;
  if (/\.(txt|md|csv|h|c)$/i.test(name) || file.type.startsWith('text/')) {
    const text = await file.text();
    return { name, pages: [text.split(/\r?\n/)] };
  }
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const count = Math.min(pdf.numPages, MAX_PAGES);
  const pages = [];
  for (let n = 1; n <= count; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(toLines(content.items));
    page.cleanup();
    onProgress(n, count);
  }
  await pdf.destroy();
  return { name, pages, truncated: pdf.numPages > MAX_PAGES, totalPages: pdf.numPages };
}

/** Agrupa los fragmentos de texto por altura (misma línea) y los ordena de izquierda a derecha. */
export function toLines(items) {
  const rows = [];
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const size = Math.hypot(item.transform[2], item.transform[3]) || 8;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, size * 0.35));
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, text: item.str, end: x + (item.width ?? 0), size });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.parts.sort((a, b) => a.x - b.x);
    let line = '';
    let last = null;
    for (const part of row.parts) {
      if (last && part.x - last.end > last.size * 0.15) line += ' ';
      line += part.text;
      last = part;
    }
    return line.replace(/\s+/g, ' ').trim();
  });
}

// ---------------------------------------------------------------- análisis

const CONTROLLER_RE = /\b(SSD\d{3,4}[A-Z]?|SH1\d{3}[A-Z]?|ST7\d{3}[A-Z0-9]{0,3}|ILI\d{4}[A-Z]?|GC9[A-Z0-9]{3}|UC8\d{3}[A-Z]?|UC1\d{3}[A-Z]?|IL\d{4}[A-Z]?|HX\d{4}[A-Z]?|NT\d{5}[A-Z]?|RM\d{5}|R61\d{3}|PCD\d{4}|S6D\d{4}|SPD\d{4}|JD\d{4}|NV3\d{3}[A-Z]?|EK\d{5}|RA8\d{3}|S1D\d{5}|KS0108|UC1701|AXS\d{4}|CO5300|SH8601|ST75\d{2}[A-Z]?)\b/g;

const UNITS_RE = /\b(mA|µA|uA|mV|ns|µs|us|ms|kHz|MHz|pF|nF|°C|Ω|ohm|Vdc|V(?=\s|$))\b/;

/** Roles reconocibles en el nombre de un comando. El orden importa: el primero que encaja gana. */
const ROLES = [
  ['curX', /ram\s*x\s*address\s*counter|x\s*address\s*counter/i],
  ['curY', /ram\s*y\s*address\s*counter|y\s*address\s*counter/i],
  ['colAddr', /column\s*address(\s*set)?\b|\bcaset\b|set\s*ram\s*x\s*address|ram\s*x\s*address\s*start|x\s*address\s*start/i],
  ['rowAddr', /\b(row|page)\s*address(\s*set)?\b|\braset\b|\bpaset\b|set\s*ram\s*y\s*address|ram\s*y\s*address\s*start|y\s*address\s*start/i],
  ['swreset', /\b(sw|soft(ware)?)\s*-?\s*reset\b|\bswreset\b/i],
  ['sleepOut', /sleep\s*out|\bslpout\b|exit\s*sleep/i],
  ['displayOn', /display\s*on\b|\bdispon\b/i],
  ['displayOff', /display\s*off\b|\bdispoff\b/i],
  ['memWriteRed', /write\s*ram.*\bred\b|\bdtm1\b|data\s*start\s*transmission\s*1/i],
  ['memWrite', /memory\s*write\b|\bramwr\b|write\s*ram\b|write\s*memory\s*start|\bdtm2\b|data\s*start\s*transmission\s*2/i],
  ['colmod', /\bcolmod\b|pixel\s*format/i],
  ['madctl', /\bmadctl\b|memory\s*(data\s*)?access\s*control/i],
  ['masterAct', /master\s*activation/i],
  ['updCtrl2', /display\s*update\s*control\s*2/i],
  ['refresh', /display\s*refresh\b|^\s*drf\s*$/i],
  ['brightness', /write\s*display\s*brightness|\bwrdisbv\b/i],
  ['contrast', /contrast/i],
  ['dataEntry', /data\s*entry\s*mode/i],
  ['driverOutput', /driver\s*output\s*control/i],
  ['border', /border\s*waveform/i],
  ['tempSensor', /temperature\s*sensor\s*(control|selection)/i],
  ['powerOn', /^\s*power\s*on\s*$|^\s*pon\s*$/i],
  ['panelSetting', /panel\s*setting|^\s*psr\s*$/i],
  ['pageStart', /set\s*page\s*start\s*address/i],
  ['colLow', /lower\s*column/i],
  ['colHigh', /higher\s*column/i],
  ['chargePump', /charge\s*pump/i],
  ['normal', /normal\s*display\s*mode|\bnoron\b/i],
  ['invOn', /display\s*inversion\s*on|\binvon\b/i],
];

const roleOf = (name) => {
  const plain = name.replace(/\s*[-–]\s*/g, ' ');
  return ROLES.find(([, re]) => re.test(plain))?.[0] ?? null;
};

/** Nombre legible de un rol cuando la hoja de datos no trae el comando. */
const ROLE_NAMES = {
  swreset: 'SWRESET', sleepOut: 'SLPOUT', displayOn: 'DISPON', displayOff: 'DISPOFF', colmod: 'COLMOD', madctl: 'MADCTL',
  updCtrl2: 'Display Update Control 2', masterAct: 'Master Activation', refresh: 'Display Refresh', powerOn: 'Power On',
  panelSetting: 'Panel Setting', chargePump: 'Charge Pump', contrast: 'Contrast', normal: 'NORON',
};

function cleanName(raw) {
  return raw.replace(/\s*\.{3,}.*$/, '').replace(/\s+\d{2,}$/, '').replace(/[\s:;,.–-]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 48);
}

function plausibleName(name) {
  if (name.length < 3 || !/[A-Za-z]{3}/.test(name)) return false;
  if (UNITS_RE.test(name)) return false;
  if (/^(table|figure|fig\.|page|note|see|section|rev|min|max|typ|pin|vdd|vss|gnd)\b/i.test(name)) return false;
  return (name.match(/\d/g) ?? []).length <= name.length / 3;
}

/** Tabla de comandos: { code -> { names: Map(name -> peso), pages: Set } }. */
function findCommands(pages) {
  const found = new Map();
  const add = (code, rawName, page, weight = 1) => {
    const name = cleanName(rawName);
    if (!plausibleName(name)) return;
    const value = parseInt(code, 16);
    if (!(value >= 0 && value <= 0xff)) return;
    if (!found.has(value)) found.set(value, { names: new Map(), pages: new Set() });
    const entry = found.get(value);
    const w = weight * (roleOf(name) ? 3 : 1);
    entry.names.set(name, (entry.names.get(name) ?? 0) + w);
    entry.pages.add(page);
  };

  pages.forEach((lines, index) => {
    const page = index + 1;
    for (const line of lines) {
      let m;
      // "SLPOUT (11h)", "Sleep Out (11h)", "Column Address Set (0x2A)"
      const inline = /([A-Za-z][A-Za-z0-9_ /&+-]{2,40}?)\s*\(\s*(?:0x)?([0-9A-Fa-f]{2})\s*[hH]?\s*\)/g;
      while ((m = inline.exec(line))) add(m[2], m[1], page, 2);
      // "(11h): Sleep Out"
      const after = /\(\s*(?:0x)?([0-9A-Fa-f]{2})[hH]\s*\)\s*[:–-]?\s*([A-Za-z][A-Za-z0-9 /_-]{2,40})/g;
      while ((m = after.exec(line))) add(m[1], m[2], page, 2);
      // "0x2A: Column Address Set", "R00H: PSR", "2Ah - CASET" (el código lleva 0x, R o h para no confundirlo con "16-bit")
      const labelled = /(?:^|\s)(?:(?:0x|R)([0-9A-Fa-f]{2})[hH]?|([0-9A-Fa-f]{2})[hH])\s*[:–-]\s*([A-Za-z][A-Za-z0-9 /_()&-]{2,40})/g;
      while ((m = labelled.exec(line))) add(m[1] ?? m[2], m[3], page, 1.5);
      // Fila de tabla con el nombre primero: "SWRESET 0 01h Software reset", "CASET 0 2Ah Column address set"
      m = line.match(/^([A-Z][A-Z0-9_]{2,11})\s+(?:[01X-]\s+){0,10}(?:0x)?([0-9A-Fa-f]{2})[hH]?\s+([A-Za-z].{2,60})$/);
      if (m && (/[hH]\s/.test(line) || /\s0x/.test(line))) add(m[2], `${m[1]} ${m[3]}`, page, 2);
      // Fila de tabla: "12 0 0 0 0 1 0 0 1 0 SW RESET", "2Ch RAMWR Memory Write", "0x24 Write RAM"
      m = line.match(/^(?:0x|R)?([0-9A-Fa-f]{2})[hH]?\s+(?:[01X]\s+){0,10}(?:\d{1,3}\s+)?(?:[0-9A-Fa-f]{2}[hH]?\s+){0,2}([A-Za-z][A-Za-z0-9 /_()&,-]{2,60})$/);
      if (m) {
        const bits = /(?:\s[01]){4,}/.test(line);
        if (bits || /[hH]$/.test(line.split(' ')[0]) || /^0x|^R/i.test(line) || roleOf(m[2])) add(m[1], m[2], page, bits ? 2 : 1);
      }
    }
  });

  return [...found.entries()]
    .map(([code, entry]) => {
      const [name, score] = [...entry.names.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
      return { code, name, score, pages: [...entry.pages].slice(0, 6), role: roleOf(name) };
    })
    .filter((c) => c.score >= 1.5 || c.role)
    .sort((a, b) => a.code - b.code);
}

function countMatches(pages, re) {
  let n = 0;
  let first = null;
  pages.forEach((lines, index) => {
    for (const line of lines) {
      const hits = line.match(re);
      if (hits) {
        n += hits.length;
        first ??= { page: index + 1, text: line.slice(0, 140) };
      }
    }
  });
  return { n, first };
}

function findController(pages) {
  const score = new Map();
  const evidence = new Map();
  pages.forEach((lines, index) => {
    const weight = index < 3 ? 4 : 1;
    for (const line of lines) {
      for (const m of line.matchAll(CONTROLLER_RE)) {
        score.set(m[1], (score.get(m[1]) ?? 0) + weight);
        if (!evidence.has(m[1])) evidence.set(m[1], { page: index + 1, text: line.slice(0, 140) });
      }
    }
  });
  const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? { value: best[0], evidence: evidence.get(best[0]) } : null;
}

function findResolution(pages) {
  const cands = new Map();
  const consider = (w, h, weight, page, line) => {
    w = Number(w);
    h = Number(h);
    if (!(w >= 8 && h >= 8 && w <= 2048 && h <= 2048)) return;
    if ((w >= 1900 && w <= 2100) || (h >= 1900 && h <= 2100)) return; // años
    const key = `${w}x${h}`;
    const c = cands.get(key) ?? { w, h, score: 0, evidence: { page, text: line.slice(0, 140) } };
    c.score += weight;
    cands.set(key, c);
  };
  pages.forEach((lines, index) => {
    const page = index + 1;
    const early = index < 5 ? 2 : 1;
    for (const line of lines) {
      let m;
      const rgb = /(?<![\d.])(\d{2,4})\s*(?:RGB|\(RGB\))\s*[x×X*]\s*(\d{2,4})(?![\d.])/g;
      while ((m = rgb.exec(line))) consider(m[1], m[2], 6 * early, page, line);
      // "176 Source x 296 Gate" es la capacidad del chip: cuenta poco frente a la resolución del panel.
      const srcGate = /(\d{2,4})\s*(?:sources?|segments?|columns?|SEG)\s*[x×X*]\s*(\d{2,4})\s*(?:gates?|commons?|rows?|COM)/gi;
      while ((m = srcGate.exec(line))) consider(m[1], m[2], 3 * early, page, line);
      const plain = /(?<![\d.])(\d{2,4})\s*[x×X*]\s*(\d{2,4})(?![\d.])(?!\s*(?:mm|cm|inch|"|µm|um))/g;
      while ((m = plain.exec(line))) {
        const context = /resolution/i.test(line) ? 10 : /pixel|dots|display|panel|matrix|active area|format/i.test(line) ? 3 : 1;
        consider(m[1], m[2], context * early, page, line);
      }
    }
  });
  const best = [...cands.values()].sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 2 ? best : null;
}

function findI2cAddr(pages) {
  let result = null;
  pages.some((lines, index) => lines.some((line) => {
    let m = line.match(/(?:slave\s*address|I2C\s*address|device\s*address)[^\n]{0,80}?(?:0x([0-9A-Fa-f]{2})|\b([0-9A-Fa-f]{2})h\b)/i);
    if (m) {
      const v = parseInt(m[1] ?? m[2], 16);
      if (v >= 0x08 && v <= 0x77) return (result = { value: v, evidence: { page: index + 1, text: line.slice(0, 140) } });
      if (v >= 0x10 && v <= 0xef && v % 2 === 0) return (result = { value: v >> 1, evidence: { page: index + 1, text: `${line.slice(0, 120)} (dirección de 8 bits, se usa ${v >> 1})` } });
    }
    m = line.match(/\b0\s?1\s?1\s?1\s?1\s?0\s?(?:SA0|[01])\b/);
    if (m && /address/i.test(line)) return (result = { value: 0x3c, evidence: { page: index + 1, text: line.slice(0, 140) } });
    return false;
  }));
  return result;
}

const ev = (c) => c?.first ?? null;

/**
 * Analiza el documento y propone { spec, profile, fields, commands }.
 * Cada campo: { key, label, value (texto legible), apply(spec, profile), evidence, found }.
 */
export function analyzeDatasheet(doc) {
  const { pages } = doc;
  const controller = findController(pages);
  const resolution = findResolution(pages);
  const i2cAddr = findI2cAddr(pages);
  const commands = findCommands(pages);
  const byRole = {};
  for (const c of commands) if (c.role && !(c.role in byRole)) byRole[c.role] = c;

  const k = (re) => countMatches(pages, re);
  const epaper = k(/e-?paper|\bEPD\b|electrophoretic|e-?ink|e\s?paper/gi);
  const color = k(/\bRGB\b|65K|262K|16\.7M|\bcolou?rs?\b/gi);
  const gray = k(/gr[ae]y\s*-?scale|\d+\s*gr[ae]y\s*levels?|\d\s*-?\s*gr[ae]y/gi);
  const oled = k(/\bOLED\b|\bPMOLED\b/gi);
  const mono = k(/monochrome|black\s*(?:and|&|\/)\s*white|1\s*-?\s*bit/gi);
  const spi = k(/\bSPI\b|serial\s*peripheral|4-?wire|3-?wire|serial\s*interface/gi);
  const threeWire = k(/3-?wire\s*(?:SPI|serial)|9-?bit\s*(?:SPI|serial)/gi);
  const fourWire = k(/4-?wire\s*(?:SPI|serial)/gi);
  const i2c = k(/\bI2C\b|\bI²C\b|\bIIC\b|\bTWI\b/gi);
  const par = k(/\b8080\b|\b6800\b|parallel\s*interface/gi);
  const pageMode = k(/page\s*addressing\s*mode|GDDRAM\s*page/gi);
  const busy = k(/\bBUSY\b/g);
  const busyLow = k(/BUSY_?N\b|BUSYN\b|busy\s*(?:is\s*)?(?:active\s*)?low/gi);
  const reset = k(/\bRES#|\bRESX\b|\bRST\b|reset\s*pin|hardware\s*reset/gi);
  const c65 = k(/65K|65,536|RGB\s*565|16-?bit\s*\/?\s*pixel/gi);
  const c262 = k(/262K|262,144|RGB\s*666|18-?bit\s*\/?\s*pixel/gi);
  const c16m = k(/16\.7M|RGB\s*888|24-?bit\s*\/?\s*pixel/gi);
  const g4 = k(/\b4\s*gr[ae]y|2-?bit\s*gr[ae]y|four\s*gr[ae]y/gi);
  const g16 = k(/16\s*gr[ae]y|4-?bit\s*gr[ae]y/gi);
  const oneIsBlack = k(/\b1\s*[=:]\s*black|\b0\s*[=:]\s*white/gi);
  const oneIsWhite = k(/\b1\s*[=:]\s*white|\b0\s*[=:]\s*black/gi);

  // ---- familia y tipo
  let kind = 'color';
  if (epaper.n >= 3) kind = 'epaper';
  else if (gray.n >= 3 && gray.n > color.n) kind = 'gray';
  else if ((oled.n >= 2 || mono.n >= 2 || pageMode.n) && c65.n + c262.n + c16m.n < 2) kind = 'mono';
  else if (color.n < 2 && mono.n >= 1) kind = 'mono';

  let family = 'blank';
  if (kind === 'epaper') family = byRole.masterAct || byRole.updCtrl2 || byRole.memWrite?.code === 0x24 ? 'epaperSsd' : byRole.refresh || byRole.panelSetting ? 'epaperUc' : 'epaperSsd';
  else if (kind === 'mono' && (pageMode.n || byRole.pageStart || /^S[SH]D?1[13]/.test(controller?.value ?? ''))) family = 'oledPages';
  else if (kind === 'color' || byRole.colAddr?.code === 0x2a) family = 'mipi';
  const profile = makeProfile(TEMPLATES[family].profile);
  profile.kind = kind;
  profile.name = controller?.value ?? '';

  // ---- formato de píxel
  if (kind === 'color') profile.pixel.format = c16m.n > Math.max(c65.n, c262.n) ? 'rgb888' : c262.n > c65.n * 2 ? 'rgb666' : 'rgb565';
  else if (kind === 'gray') profile.pixel.format = g16.n > g4.n ? 'gray4' : 'gray2';
  else if (family !== 'oledPages' && kind === 'mono') profile.pixel.format = 'mono1-h';
  // Polaridad: bit 1 = píxel claro salvo que la hoja de datos diga "1 = negro".
  if (formatInfo(profile.pixel.format).kind !== 'color') profile.pixel.bitOn = !(oneIsBlack.n > oneIsWhite.n);

  // ---- interfaces
  const buses = [];
  if (spi.n) buses.push('spi');
  if (i2c.n) buses.push('i2c');
  if (par.n) buses.push('8080');
  if (buses.length) profile.buses = buses;
  if (profile.buses[0] === 'i2c') profile.dc = 'i2c';
  else if (threeWire.n && !fourWire.n) profile.dc = 'spi9';
  else profile.dc = 'pin';
  if (i2cAddr) profile.i2cAddr = i2cAddr.value;
  profile.reset = reset.n > 0 || profile.reset;
  profile.busy = busy.n >= 2 ? (busyLow.n ? 'low' : 'high') : kind === 'epaper' ? profile.busy : null;

  // ---- comandos
  const code = (role) => byRole[role]?.code;
  if (family === 'oledPages') {
    if (code('pageStart') != null) profile.window.page = code('pageStart') & 0xf8;
  } else if (profile.window.mode === 'addr' || code('colAddr') != null) {
    if (code('colAddr') != null) {
      profile.window.mode = 'addr';
      profile.window.col = code('colAddr');
    }
    if (code('rowAddr') != null) profile.window.row = code('rowAddr');
    if (code('curX') != null) profile.window.curX = code('curX');
    if (code('curY') != null) profile.window.curY = code('curY');
  }
  if (code('memWrite') != null) profile.write = code('memWrite');
  if (code('brightness') != null) profile.brightness = { cmd: code('brightness'), max: 255 };
  else if (code('contrast') != null) profile.brightness = { cmd: code('contrast'), max: 255 };
  if (code('madctl') != null) profile.rotate = { cmd: code('madctl'), values: [0x00, 0x60, 0xc0, 0xa0] };

  const width = resolution?.w;
  const height = resolution?.h;
  const line = (role, data = [], extra = '', fallback = null) => {
    const c = byRole[role];
    const cmd = c?.code ?? fallback;
    if (cmd == null) return null;
    return stepLine(cmd, data, `${c?.name ?? ROLE_NAMES[role] ?? role}${extra}`);
  };
  const init = [];
  const push = (...items) => items.forEach((it) => it && init.push(it));
  if (family === 'mipi') {
    push(line('swreset', [], '', 0x01), 'delay 150', line('sleepOut', [], '', 0x11), 'delay 120');
    const colmod = { rgb565: 0x55, rgb666: 0x66, rgb888: 0x77, rgb332: 0x22 }[profile.pixel.format] ?? 0x55;
    push(line('colmod', [colmod], ': revisa el valor', 0x3a));
    if (code('madctl') != null) push(line('madctl', [0x00]));
    if (code('invOn') != null && /IPS/i.test(pages.flat().join(' ').slice(0, 20000))) push(line('invOn'));
    push(line('normal'), line('displayOn', [], '', 0x29), 'delay 20');
  } else if (family === 'epaperSsd') {
    const h = (height ?? 296) - 1;
    push('reset', 'busy', line('swreset', [], '', 0x12), 'busy');
    push(line('driverOutput', [h & 0xff, h >> 8, 0x00], ': alto - 1'), line('dataEntry', [0x03], ': X e Y crecientes'), line('border', [0x05]), line('tempSensor', [0x80]), 'busy');
    profile.update = [line('updCtrl2', [0xf7], '', 0x22), line('masterAct', [], '', 0x20), 'busy'].filter(Boolean).join('\n');
  } else if (family === 'epaperUc') {
    push('reset', 'busy', line('powerOn', [], '', 0x04), 'busy', line('panelSetting', [0x1f], ': revisa el valor'));
    profile.update = [line('refresh', [], '', 0x12), 'delay 100', 'busy'].filter(Boolean).join('\n');
  } else if (family === 'oledPages') {
    push(line('displayOff', [], '', 0xae));
    if (height) push(stepLine(0xa8, [height - 1], 'multiplex ratio: alto - 1'));
    push(line('chargePump', [0x14]), line('contrast', [0xcf]), line('displayOn', [], '', 0xaf));
  } else {
    push(line('swreset'), line('sleepOut'), line('displayOn'));
  }
  if (init.length) profile.init = init.join('\n');

  // ---- campos para revisar
  const fmtLabel = { 'mono1-h': '1 bit por filas', 'mono1-v': '1 bit por páginas', gray2: '4 grises', gray4: '16 grises', rgb565: 'RGB565', rgb666: 'RGB666', rgb888: 'RGB888' };
  const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
  const cmdText = (role) => (byRole[role] ? `${hex(byRole[role].code)} ${byRole[role].name}` : null);
  const pageEv = (role) => (byRole[role] ? { page: byRole[role].pages[0], text: byRole[role].name } : null);

  const fields = [
    { key: 'name', label: 'Controlador', value: controller?.value, evidence: controller?.evidence, found: Boolean(controller) },
    { key: 'resolution', label: 'Resolución', value: resolution ? `${resolution.w} x ${resolution.h}` : null, evidence: resolution?.evidence, found: Boolean(resolution) },
    { key: 'kind', label: 'Tipo de panel', value: { mono: 'Monocromo', epaper: 'E-paper', gray: 'Grises', color: 'Color' }[kind], evidence: ev(kind === 'epaper' ? epaper : kind === 'gray' ? gray : kind === 'mono' ? (oled.n ? oled : mono) : color), found: true },
    { key: 'format', label: 'Formato de píxel', value: fmtLabel[profile.pixel.format] ?? profile.pixel.format, evidence: ev(c16m.n ? c16m : c262.n ? c262 : c65.n ? c65 : g16.n ? g16 : g4.n ? g4 : pageMode), found: true },
    { key: 'family', label: 'Familia (plantilla)', value: TEMPLATES[family].label, evidence: null, found: family !== 'blank' },
    { key: 'buses', label: 'Interfaces', value: buses.length ? buses.map((b) => ({ spi: 'SPI', i2c: 'I2C', 8080: 'Paralelo 8080' })[b]).join(', ') : null, evidence: ev(spi.n ? spi : i2c.n ? i2c : par), found: buses.length > 0 },
    { key: 'dc', label: 'Señal D/C', value: { pin: 'Pin D/C', spi9: 'SPI de 9 bits', i2c: 'Byte de control I2C' }[profile.dc], evidence: ev(threeWire.n ? threeWire : fourWire), found: spi.n + i2c.n > 0 },
    { key: 'i2cAddr', label: 'Dirección I2C', value: i2cAddr ? hex(i2cAddr.value) : null, evidence: i2cAddr?.evidence, found: Boolean(i2cAddr) },
    { key: 'pins', label: 'Pines', value: [profile.reset ? 'RESET' : null, profile.busy ? `BUSY activo ${profile.busy === 'low' ? 'bajo' : 'alto'}` : null].filter(Boolean).join(', ') || null, evidence: ev(busy.n ? busy : reset), found: reset.n + busy.n > 0 },
    { key: 'window', label: 'Ventana de RAM', value: [cmdText('colAddr'), cmdText('rowAddr'), cmdText('curX'), cmdText('curY'), family === 'oledPages' ? 'por páginas' : null].filter(Boolean).join(' · ') || null, evidence: pageEv('colAddr') ?? pageEv('pageStart'), found: Boolean(byRole.colAddr || byRole.rowAddr || family === 'oledPages') },
    { key: 'write', label: 'Escritura de RAM', value: cmdText('memWrite'), evidence: pageEv('memWrite'), found: Boolean(byRole.memWrite) },
    { key: 'update', label: 'Refresco', value: [cmdText('updCtrl2'), cmdText('masterAct'), cmdText('refresh')].filter(Boolean).join(' · ') || null, evidence: pageEv('masterAct') ?? pageEv('refresh'), found: Boolean(byRole.masterAct || byRole.refresh) },
    { key: 'brightness', label: 'Brillo', value: cmdText('brightness') ?? cmdText('contrast'), evidence: pageEv('brightness') ?? pageEv('contrast'), found: Boolean(byRole.brightness || byRole.contrast) },
    { key: 'rotate', label: 'Rotación por hardware', value: cmdText('madctl'), evidence: pageEv('madctl'), found: Boolean(byRole.madctl) },
    { key: 'init', label: 'Secuencia de arranque', value: `${init.filter((l) => !/^(delay|busy|reset)/.test(l)).length} comandos propuestos`, evidence: null, found: init.length > 0 },
  ];

  return {
    source: { file: doc.name, pages: doc.pages.length, totalPages: doc.totalPages ?? doc.pages.length },
    spec: { label: controller?.value ?? '', width, height },
    profile,
    fields,
    commands,
    lineCount: pages.reduce((n, p) => n + p.length, 0),
  };
}
