import { PIXEL_FORMAT } from '../serial/protocol.js';
import { BAUD_RATE } from '../serial/serial-manager.js';
import { logicalSize } from './display-configs.js';

/** Bytes del payload de un frame y tiempo de envío por USB (10 bits por byte con 8N1). */
export function frameCost(config, rotation = 0) {
  const { width, height } = logicalSize(config, rotation);
  const bytes = config.format === PIXEL_FORMAT.RGB565_LE ? width * height * 2 : Math.ceil(width / 8) * height;
  return { bytes, ms: ((bytes + 17) * 10 * 1000) / BAUD_RATE };
}
