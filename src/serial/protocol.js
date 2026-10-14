import { crc16ccitt } from './crc16.js';

/*
  Protocolo USB-serial (921600 baud, 8N1)

  1) Comandos JSON: un objeto por línea, terminado en "\n". Siempre empiezan con "{".
  2) Frames binarios (little-endian, sin padding):

     offset  tamaño  campo
     0       4       magic "UID1" (0x55 0x49 0x44 0x31)
     4       1       comando (0x10 = frame de imagen)
     5       1       display id
     6       2       ancho  (uint16 LE)
     8       2       alto   (uint16 LE)
     10      1       formato (1 = RGB565 LE, 2 = 1 bit/píxel)
     11      4       longitud del payload (uint32 LE)
     15      2       CRC-16 CCITT del payload (uint16 LE)
     17      n       payload

  El ESP32 responde con líneas de texto: "OK ...", "ERR ..." o "READY ...".
*/

export const MAGIC = new Uint8Array([0x55, 0x49, 0x44, 0x31]); // "UID1"
export const CMD_FRAME = 0x10;
export const HEADER_SIZE = 17;
export const CHUNK_SIZE = 1024;

export const PIXEL_FORMAT = Object.freeze({
  RGB565_LE: 1,
  MONO_1BPP: 2,
});

/** Serializa un comando JSON como bytes UTF-8 terminados en salto de línea. */
export function encodeJsonCommand(command) {
  return new TextEncoder().encode(`${JSON.stringify(command)}\n`);
}

/** Construye los 17 bytes de cabecera para un payload ya codificado. */
export function buildFrameHeader({ displayId, width, height, format, payload }) {
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  header.set(MAGIC, 0);
  view.setUint8(4, CMD_FRAME);
  view.setUint8(5, displayId);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  view.setUint8(10, format);
  view.setUint32(11, payload.length, true);
  view.setUint16(15, crc16ccitt(payload), true);
  return header;
}

/** Divide el payload en bloques de 1024 bytes (el último puede ser menor). */
export function* chunkPayload(payload, size = CHUNK_SIZE) {
  for (let offset = 0; offset < payload.length; offset += size) {
    yield payload.subarray(offset, Math.min(offset + size, payload.length));
  }
}

// Constructores de comandos JSON.
export const commands = {
  config: (display, brightness, rotation) => ({ cmd: 'config', display, brightness, rotation }),
  lcd: (lines) => ({ cmd: 'lcd', lines }),
  glyph: (slot, rows) => ({ cmd: 'glyph', slot, rows }),
  glyphAt: (slot, col, row) => ({ cmd: 'glyphAt', slot, col, row }),
  // Extensión: escribe códigos crudos (0-7 = CGRAM, 0x80-0xFF = ROM del LCD) desde (row, col).
  lcdRaw: (row, col, codes) => ({ cmd: 'lcdRaw', row, col, codes }),
};
