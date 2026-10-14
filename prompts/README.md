# Prompts de firmware

Prompts para pedir a un asistente de código el firmware que recibe los diseños de ESP32 Display Studio por USB. Los tres describen el mismo protocolo, las mismas pantallas (integradas, creadas en la app y drivers exportados desde Código C), la conversión de píxeles y el táctil. Cambian la plataforma y las bibliotecas.

| Prompt | Para | Elígelo si… |
|---|---|---|
| [prompt-firmware-esp32s3.md](prompt-firmware-esp32s3.md) | ESP32-S3 con **ESP-IDF 5** (C99) | quieres el máximo rendimiento y control: DMA, PSRAM, paneles QSPI y RGB, tareas en dos núcleos. |
| [prompt-firmware-arduino-esp32.md](prompt-firmware-arduino-esp32.md) | ESP32, ESP32-S3, C3, C6 y Nano ESP32 con **Arduino** (IDE 2 o PlatformIO) | prefieres Arduino y bibliotecas conocidas (Arduino_GFX/LovyanGFX, U8g2, GxEPD2, LiquidCrystal) con el mismo alcance de pantallas. |
| [prompt-firmware-arduino-placas.md](prompt-firmware-arduino-placas.md) | Placas Arduino **sin ESP32** con USB nativo: RP2040/Pico, Teensy 4, SAMD21/51, Uno R4, Leonardo/Micro | ya tienes una de esas placas. Se adapta a su RAM (frames con búfer, en streaming o en modo mínimo). Uno R3, Nano y Mega no sirven. |

Uso: abre el archivo, copia desde "Rol" hasta el final y pégalo en tu asistente. Antes de escribir código, el prompt pide al asistente que te pregunte la placa, las pantallas, los pines y si hay PSRAM.

Si cambias el protocolo de la app (`src/serial/protocol.js`), los formatos de píxel (`src/displays/native-format.js`) o el catálogo de pantallas (`src/displays/display-catalog.js`), actualiza los tres prompts: comparten esas secciones palabra por palabra.
