// CRC-16/CCITT-FALSE: polinomio 0x1021, valor inicial 0xFFFF, sin reflexión.
// Es idéntico a crc16() del firmware (esp32_display_bridge.ino).
export function crc16ccitt(data, init = 0xffff) {
  let crc = init;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
