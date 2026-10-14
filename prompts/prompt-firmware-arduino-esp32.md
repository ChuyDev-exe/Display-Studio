# Prompt: firmware Arduino (ESP32 / ESP32-S3) para ESP32 Display Studio

> Copia desde "Rol" hasta el final y pégalo en tu asistente de código.

---

## Rol

Eres un ingeniero de firmware embebido senior con experiencia en el ecosistema Arduino. Escribe el firmware completo, como **sketch de Arduino para placas ESP32** (prioridad: **ESP32-S3**; también ESP32 clásico, ESP32-C3/C6 y Arduino Nano ESP32), que recibe por **USB** comandos y frames desde la app web "ESP32 Display Studio" (Web Serial) y los muestra **en tiempo real** en distintas pantallas: TFT, AMOLED, OLED monocromo y de grises, e-paper, LCD gráficos y LCD de caracteres, con o sin panel táctil. La app ya existe; el firmware debe cumplir **exactamente** el protocolo descrito abajo.

## Restricciones de ingeniería

- **Core arduino-esp32 3.x** (basado en ESP-IDF 5). Compila en **Arduino IDE 2** y en **PlatformIO** (entrega `platformio.ini` con un entorno por placa). Indica en el README las versiones probadas del core y de cada biblioteca.
- C++17 sin excepciones ni RTTI en el camino caliente. Nada de `String` ni de memoria dinámica mientras se recibe: reserva los búferes al seleccionar la pantalla (`ps_malloc`/`heap_caps_malloc` con PSRAM para los grandes).
- Código modular y probable en PC: el **parser del protocolo, el CRC y las conversiones de píxel** van en `.h/.cpp` sin dependencias de Arduino, para compilarlos y testearlos en el host (PlatformIO `native` o CMake).
- Cada pantalla va detrás de una clase abstracta `Display` (begin, end, setRotation, setBrightness, drawFrame y opcionales lcd* para HD44780), y cada táctil detrás de `Touch` (begin, end, read). Añadir una pantalla = una clase (o reutilizar una familia) + una fila en la tabla de `displays.cpp`. Solo se construye el objeto de la pantalla activa; al cambiar con `config` se destruye el anterior.
- Pines, buses, direcciones, frecuencias, offsets, táctil y qué pantallas se compilan van en `config.h` (con `#define ENABLE_<CLAVE>`), con valores por defecto para un ESP32-S3 DevKitC-1 N16R8. **No** se envían por USB.

## Bibliotecas

Usa bibliotecas mantenidas y, para cada familia, una sola:

- **TFT y AMOLED** (SPI, QSPI, 8080 y RGB paralelo): **GFX Library for Arduino** (Arduino_GFX) o **LovyanGFX**. Elige una, justifícalo y úsala para todas: ambas cubren ST7789, GC9A01, ILI9341/9342/9486/9488, ST7735, ST7796, HX8357 y el bus RGB del S3 (ST7701S); Arduino_GFX cubre además los AMOLED QSPI (NV3041A, RM67162, SH8601, CO5300). Dibuja con `draw16bitRGBBitmap`/`pushImage` sobre DMA, nunca píxel a píxel.
- **OLED mono y LCD mono**: **U8g2** (SSD1306, SH1106, SSD1309, SSD1305, SH1107, PCD8544, ST7565, UC1701, ST7920, KS0108, Sharp LS0xx) escribiendo directamente su búfer (`getBufferPtr`) con el formato de páginas y `sendBuffer()`.
- **OLED de grises** (SSD1322, SSD1327): usa el driver exportado por la app (formato de 4 bits) o una biblioteca de 4 bpp; no los reduzcas a 1 bit.
- **E-paper**: **GxEPD2** (SSD16xx y UC81xx), con su clase de panel elegida en `config.h`.
- **HD44780**: **LiquidCrystal** (GPIO) y **LiquidCrystal_I2C** o **hd44780** de Bill Perry (PCF8574), con `createChar` para la CGRAM y `write(code)` para los códigos crudos.
- **Táctil**: **bb_captouch** (FT6x36, FT5x06, GT911, CST816, CST226...) para los capacitivos y **XPT2046_Touchscreen** para el XPT2046; TSC2007, NS2009 y STMPE610 con su biblioteca de Adafruit o lectura I2C/SPI directa.

## Transporte USB

- **ESP32-S3, C3 y C6**: USB nativo. Activa **"USB CDC On Boot: Enabled"** (en PlatformIO, `-D ARDUINO_USB_CDC_ON_BOOT=1`) para que `Serial` sea el USB. El baudrate (921600) es irrelevante en CDC. Detecta la apertura del puerto por el host (DTR, con los eventos del CDC o `if (Serial)`) y envía `READY`.
- **ESP32 clásico**: puente USB-UART de la placa a **921600 8N1**; amplía el búfer RX (`Serial.setRxBufferSize(16384)` antes de `begin`).
- En el S3 amplía también el búfer RX del CDC si tu versión del core lo permite, y lee en bloques con `Serial.read(buf, n)`, no byte a byte.
- **Nada de `Serial.print` de depuración**: rompe el protocolo. Pon "Core Debug Level: None" y manda los logs a `Serial0`/`Serial1` (UART) con una macro `DBG(...)` que se compila a nada por defecto.
- `MAX_FRAME` en `config.h`. Por defecto 115 200 B (240x240 RGB565) sin PSRAM; con PSRAM (**"PSRAM: OPI PSRAM"** en módulos N8R8/N16R8) hasta 800x480x2 = 768 000 B. Si una pantalla compilada no cabe en `MAX_FRAME`, avísalo por `DBG` al arrancar y responde `ERR too large` a sus frames.
- Con ~1 MB/s reales, un frame RGB565 de 240x240 debe llegar a ≥ 8 fps en el S3. Mide y documenta el resultado.

## Protocolo

El flujo del host es **mixto**: líneas de texto JSON y frames binarios, intercalados en el mismo stream.

### Desambiguar y resincronizar

- Si el primer byte pendiente es `{` → comando JSON hasta `\n` (máx. 512 B; si se excede, `ERR line too long` y descarta hasta `\n`).
- Si empieza por `U` (`0x55`) → cabecera binaria, magic `"UID1"` = `55 49 44 31`.
- Cualquier otro byte: descártalo hasta encontrar `\n` o el magic. Nunca te bloquees por basura.
- Si un frame se queda sin recibir bytes durante **500 ms** a mitad de payload → `ERR timeout` y vuelve a resincronizar.

### Respuestas (una línea terminada en `\n`)

- `READY <nombre-firmware> <versión>` al arrancar y cuando el host abre el puerto (DTR).
- `OK <cmd>` o `OK <cmd> <display>` tras ejecutar cada comando (`OK frame` tras mostrar un frame).
- `ERR <motivo corto>` ante cualquier fallo. La app muestra el texto al usuario, así que debe ser legible (`ERR unknown display`, `ERR crc`, `ERR size`, `ERR no config`...).
- La app enseña en su consola **cualquier** línea recibida. Las que no empiezan por `READY`, `OK` o `ERR` se muestran sin interpretar: úsalas solo para eventos opcionales (ver "Táctil") y nunca para logs de depuración.

### Frame binario (little-endian, sin padding)

| offset | tamaño | campo |
|---|---|---|
| 0 | 4 | magic `"UID1"` |
| 4 | 1 | comando `0x10` = frame de imagen |
| 5 | 1 | display id |
| 6 | 2 | ancho (uint16 LE), **lógico**, ya rotado |
| 8 | 2 | alto (uint16 LE), **lógico**, ya rotado |
| 10 | 1 | formato: `1` = RGB565 LE, `2` = mono 1 bpp |
| 11 | 4 | longitud del payload (uint32 LE) |
| 15 | 2 | CRC-16 del payload (uint16 LE) |
| 17 | n | payload |

- **CRC-16/CCITT-FALSE**: polinomio `0x1021`, init `0xFFFF`, sin reflexión, sin xorout. Vector de prueba: `"123456789"` → `0x29B1`.
- El host envía el payload en escrituras de 1024 B, pero **no espera ACK por bloque**. En las animaciones tampoco espera el `OK` entre frames: se guía por tiempo. El firmware debe absorber el flujo sin perder la sincronía.
- **Solo hay dos formatos en el cable**, sea cual sea el panel:
  - **RGB565 LE** (`1`): pantallas de color y de **escala de grises**. 2 bytes por píxel, byte bajo primero, filas de arriba abajo. Longitud = `ancho*alto*2`.
  - **Mono 1 bpp** (`2`): OLED monocromo, LCD gráfico monocromo y **e-paper**. Row-major, MSB primero, `ceil(ancho/8)` bytes por fila. **Bit 1 = píxel claro** (blanco en el editor: píxel encendido en un OLED, papel en un e-paper, píxel apagado en un LCD reflectivo). Longitud = `ceil(ancho/8)*alto`.
  - El firmware convierte después al formato nativo de cada chip (ver "Conversión al formato nativo").
- Valida, en este orden: magic → display id igual al seleccionado con `config` (`ERR display mismatch`) → ancho y alto iguales al tamaño lógico esperado (`ERR size`) → formato correcto para esa pantalla (`ERR format`) → longitud coherente y ≤ `MAX_FRAME` (`ERR too large`) → CRC (`ERR crc`). Ante cualquier error, **consume y descarta el payload** declarado (si la longitud es plausible) para no perder la sincronía.

### Comandos JSON (un objeto por línea)

```json
{"cmd":"config","display":"gc9a01","brightness":70,"rotation":0}
{"cmd":"lcd","lines":["Hola mundo","Linea 2"]}
{"cmd":"glyph","slot":0,"rows":[0,10,31,31,14,4,0,0]}
{"cmd":"glyphAt","slot":0,"col":15,"row":0}
{"cmd":"lcdRaw","row":0,"col":3,"codes":[72,111,223,0]}
```

- **`config`**: selecciona la pantalla activa por su **clave** (string). Si cambia, desinicializa la anterior y libera sus búferes, inicializa la nueva y la limpia (negro; blanco en e-paper). Aplica `brightness` (0–100) y `rotation` (0–3, pasos de 90° en sentido horario, convención `setRotation` de TFT_eSPI). Es lo primero que envía la app al conectar y al cambiar de pantalla. Clave desconocida → `ERR unknown display`. El resto de comandos sin `config` previo → `ERR no config`.
- **`lcd`** (solo HD44780): hace `clear` y escribe cada línea desde la columna 0 de su fila. Recorta a `cols`.
- **`glyph`**: programa un carácter personalizado en la CGRAM: `slot` 0–7, `rows` = 8 enteros 0–31 (el bit 4 es la columna izquierda).
- **`glyphAt`**: posiciona el cursor en (`col`,`row`) y escribe el código `slot` (0–7). Valida los límites (`ERR out of range`).
- **`lcdRaw`**: desde (`row`,`col`) escribe los `codes` crudos **sin limpiar** (0–7 = CGRAM, 0x20–0x7E ASCII, 0x80–0xFF ROM). Lo usan las animaciones para sobrescribir filas sin parpadeo: debe ser rápido y no hacer `clear`.
- Comandos JSON en una pantalla del tipo equivocado (`lcd` en una TFT) → `ERR wrong display type`.

## Pantallas

### Integradas en la app

| clave | id | controlador | tamaño nativo | formato en el cable |
|---|---|---|---|---|
| `lcd16x2` | 1 | HD44780 | 16x2 caracteres | texto (JSON) |
| `lcd20x4` | 2 | HD44780 | 20x4 caracteres | texto (JSON) |
| `nokia5110` | 3 | PCD8544 | 84x48 | mono, SPI |
| `ssd1306` | 4 | SSD1306 | 128x64 | mono, I2C (0x3C) o SPI |
| `gc9a01` | 6 | GC9A01 | 240x240 redonda | RGB565, SPI |
| `st7789` | 7 | ST7789 | 240x240 | RGB565, SPI |

### Pantallas propias (creadas en la app)

La app permite añadir **cualquier** pantalla: el usuario elige la tecnología (TFT/IPS, AMOLED/OLED color, OLED monocromo, OLED de grises, e-paper, LCD gráfico monocromo, LCD de caracteres u "Otra"), el driver (de un catálogo o "Otro"), la resolución nativa (de 8 a 1024 px por lado), la diagonal y el panel táctil. Para el firmware importa esto:

- **Clave**: el nombre en minúsculas, sin acentos, con cada tramo que no sea letra o número convertido en un guion y sin guiones en los extremos. Ejemplo: «ILI9488 320x480» → `ili9488-320x480`. El usuario la ve en la consola de la app, en el `config` que se envía al elegir la pantalla.
- **id**: de 16 a 255, único. La app lo muestra en Propiedades como "ID de firmware".
- **Tamaño nativo** sin rotar; el frame llega en tamaño lógico (ancho y alto intercambiados con 90°/270° si no es cuadrada).
- La tabla de pantallas debe estar **en un solo sitio** y añadir una pantalla propia ha de ser **una fila** (clave, id, driver, ancho, alto, bus, pines, offsets, opciones), sin tocar el resto del código.

### Catálogo de drivers que la app ofrece

Da soporte de primera clase a los marcados con ★ (los integrados) y deja preparados los demás como entradas de la tabla activables en la configuración. Agrúpalos por familia para compartir código:

| familia | drivers del catálogo | bus | formato nativo |
|---|---|---|---|
| TFT MIPI DCS | ★ST7789, ★GC9A01, ILI9341, ST7735, ILI9486, ST7796, HX8357D, ILI9342 | SPI (8080 opcional) | RGB565 big-endian |
| TFT 18 bits | ILI9488 | SPI | RGB666 (3 bytes; por SPI no admite 16 bits) |
| TFT QSPI | NV3041A | QSPI | RGB565 |
| TFT RGB paralelo | ST7701S (480x480, 480x854) | RGB (DE/VSYNC/HSYNC/PCLK) + SPI de 9 bits para el arranque | RGB565 por el bus RGB |
| AMOLED QSPI | RM67162, SH8601, CO5300 | QSPI | RGB565; brillo con el comando `0x51` |
| OLED color | SSD1351, SSD1331 | SPI | RGB565; ventana `0x15`/`0x75`, escritura `0x5C` (SSD1331 sin comando de escritura) |
| OLED mono por páginas | ★SSD1306, SH1106, SSD1309, SSD1305, SH1107 | I2C o SPI | 1 bit, páginas de 8 filas (bit 0 arriba); SH1106: columna inicial 2 |
| OLED de grises | SSD1322, SSD1327, SSD1363 | SPI o I2C | 4 bits por píxel (16 grises) |
| E-paper SSD16xx | SSD1680, SSD1681, SSD1675, SSD1677 | SPI + BUSY | 1 bit por filas; RAM B/N `0x24`, refresco `22 F7` + `20` |
| E-paper UC81xx | UC8151/IL0373, UC8176, UC8179 | SPI + BUSY | 1 bit por filas; datos `0x13`, refresco `0x12` |
| LCD mono | ★PCD8544, ST7565, UC1701, KS0108 (8080), ST7920 (modo gráfico extendido), Sharp Memory LCD (sin D/C, línea a línea, VCOM) | SPI / 8080 | 1 bit (páginas o filas) |
| LCD de caracteres | ★HD44780, ST7066/SPLC780D, AIP31068 | 4/8 bits o I2C (PCF8574) | texto + 8 glifos CGRAM |

### Drivers exportados desde la app ("Código C")

Para un driver sin soporte propio, la pestaña Código C de la app genera un driver C99 a partir de su perfil de protocolo:

- `drv_port.h`: lo único que implementa la plataforma: `drv_port_write_command(uint8_t)`, `drv_port_write_data(const uint8_t*, size_t)`, `drv_port_delay_ms(uint32_t)` y, si el panel los tiene, `drv_port_reset()` y `drv_port_busy()`. La cabecera explica cómo va la señal D/C (pin, noveno bit en SPI de 3 hilos o byte de control I2C).
- `drv_<id>.c/.h`: `drv_init()`, `drv_flush(const uint8_t fb[DRV_FB_BYTES])` (ventana + escritura de RAM + refresco) y `drv_set_brightness(uint8_t percent)`, con `DRV_FB_BYTES` en el formato nativo.

El firmware debe incluir un **adaptador genérico** (`display_ops` sobre estos drivers): recibe el frame del protocolo (RGB565 o mono, en tamaño lógico), lo gira al tamaño nativo, lo convierte al formato nativo en un framebuffer de `DRV_FB_BYTES` y llama a `drv_flush`. Así, cualquier pantalla creada en la app funciona copiando sus archivos exportados, implementando `drv_port.h` para el bus y añadiendo una fila a la tabla. Documenta el procedimiento paso a paso en el README.

## Conversión al formato nativo

La app ya muestra en su vista previa cómo quedará cada píxel. El firmware debe hacer **la misma** conversión, bit a bit:

- RGB565 → componentes de 8 bits: `r8 = (r5<<3)|(r5>>2)`, `g8 = (g6<<2)|(g6>>4)`, `b8 = (b5<<3)|(b5>>2)`.
- **Luminancia** entera: `luma = (r8*77 + g8*150 + b8*29) >> 8`.
- **RGB565 big-endian** (MIPI): intercambia los dos bytes (o configura el orden de bytes del bus o del DMA para no gastar CPU). Contempla paneles **BGR**.
- **RGB666**: `r8 & 0xFC, g8 & 0xFC, b8 & 0xFC`, 3 bytes por píxel. **RGB888**: 3 bytes. **RGB332**: `(r8 & 0xE0) | ((g8>>3) & 0x1C) | (b8>>6)`.
- **Grises**: 16 niveles = `luma >> 4` (dos píxeles por byte, el de la izquierda en el nibble alto); 4 niveles = `luma >> 6` (cuatro por byte, el de la izquierda en los bits altos).
- **1 bit por filas** (e-paper, Sharp, ST7920): el mismo orden que el cable; si el chip usa "1 = tinta", invierte. Sharp Memory LCD espera LSB primero.
- **1 bit por páginas** (SSD13xx, SH11xx, PCD8544, ST7565, UC1701, KS0108): byte `[(y>>3)*ancho + x]`, bit `y & 7`.
- **Rotación**: el frame llega en tamaño lógico. Si el panel la hace por hardware (MADCTL, swap/mirror), úsala. Si no (OLED/LCD por páginas, e-paper, Sharp, framebuffers propios), gira en software al convertir. La convención: con rotación 1, el píxel lógico `(lx, ly)` va al nativo `(nx, ny)` con `lx = ny`, `ly = W-1-nx`; con 2, `lx = W-1-nx`, `ly = H-1-ny`; con 3, `lx = H-1-ny`, `ly = nx` (W y H nativos).
- Panel **redondo** (GC9A01, CO5300 466x466): el frame sigue siendo cuadrado; no recortes nada.

## Detalles por tecnología

- **TFT e IPS**: offsets de ventana por panel (135x240, 170x320, 172x320, 240x240 sobre RAM de 240x320...). Brillo = PWM del backlight (si el pin es -1, ignóralo).
- **AMOLED QSPI**: comando en la cabecera de la transacción QSPI (`0x02` + `00 <cmd> 00` para escribir registros, `0x32` para píxeles, según el chip). Brillo por comando `0x51` (0–255). Muchos exigen ventanas con coordenadas **pares**.
- **RGB paralelo (ST7701S)**: framebuffer en PSRAM servido por el periférico RGB; el arranque va por SPI de 9 bits. Doble framebuffer o "bounce buffers" para evitar el tearing.
- **OLED mono**: brillo = contraste (SSD1306 `0x81` + 0–255). **OLED de grises**: SSD1322 cuenta las columnas de 4 en 4 píxeles; SSD1327, de 2 en 2.
- **E-paper**: un refresco completo tarda de 1 a 15 s. Política: el último frame gana; mientras refresca, guarda solo el más reciente y aplícalo al terminar; respeta un intervalo mínimo configurable entre refrescos; espera `BUSY` sin bloquear la recepción; después de refrescar, pon el panel en reposo profundo. `OK frame` al terminar el refresco. El brillo no aplica (responde `OK config` igualmente). Refresco parcial opcional y configurable.
- **LCD mono**: brillo = contraste/Vop (PCD8544, ST7565, UC1701) o backlight. Sharp Memory LCD necesita conmutar VCOM periódicamente (≥ 1 Hz) aunque no cambie la imagen.
- **HD44780**: I2C con expansor PCF8574 (mapeo estándar P0=RS, P1=RW, P2=E, P3=backlight, P4–P7=D4–D7; dirección 0x27 configurable) o 4/8 bits por GPIO. Secuencia de arranque oficial (0x30 x3, modo 4 bits, function set, display off, clear, entry mode, display on). Direcciones DDRAM: filas `0x00, 0x40, cols, 0x40+cols`. Respeta los tiempos (clear ≈ 1,6 ms). AIP31068: I2C nativo con byte de control. Brillo = backlight.

## Táctil

En la app, cada pantalla puede declarar un panel táctil: capacitivo o resistivo, controlador (FT6206/FT6236/FT6336, FT5x06/FT5436, GT911, CST816S/T, CST328/CST226, CHSC6x, XPT2046/ADS7843, TSC2007, NS2009, STMPE610 u otro), bus (I2C o SPI), dirección I2C, puntos simultáneos y pines INT y RESET. Se exporta en `ui_config.h` como `UI_TOUCH_CAPACITIVE`/`UI_TOUCH_RESISTIVE`, `UI_TOUCH_I2C_ADDR`, `UI_TOUCH_POINTS`, `UI_TOUCH_HAS_INT` y `UI_TOUCH_HAS_RST`.

- Añade el táctil a la fila de cada pantalla (controlador, bus, dirección, pines, `swap_xy`/`mirror` y calibración para los resistivos). Se inicializa con la pantalla en `config` y se libera al cambiar.
- Convierte las coordenadas al **espacio lógico** de la rotación activa, el mismo del lienzo de la app.
- **Opcional y desactivado por defecto**: informar al host con líneas `EVT touch <down|move|up> <x> <y>`, como máximo 30 por segundo y solo cuando cambia algo. La app actual solo las muestra en su consola; nunca deben empezar por `OK`, `ERR` ni `READY`.
- Los resistivos que comparten el SPI de la pantalla usan su propio CS y un reloj ≤ 2 MHz; arbitra el bus para no leer el táctil a mitad de un DMA de la pantalla.
- Incluye una rutina de calibración para los resistivos (cuatro esquinas) que guarde los coeficientes en memoria no volátil.

## Tiempo real

- Dos tareas FreeRTOS (`xTaskCreatePinnedToCore`): **recepción** en el núcleo 0 (lee `Serial` en bloques y alimenta el parser) y **dibujo** en el núcleo 1. El `loop()` de Arduino queda vacío o solo vigila el táctil. En los ESP32 de un solo núcleo (C3, C6), dos tareas con prioridades distintas.
- Recibe el payload en un búfer (PSRAM si hace falta), verifica el CRC y solo entonces convierte y dibuja.
- Política **"el último gana"**: cola de profundidad 1 entre recepción y dibujo; los frames intermedios se descartan.
- Conversión por bandas de líneas (por ejemplo, 16 líneas) a un búfer DMA en memoria interna, solapando conversión y envío.

## Entregables

1. Proyecto que compila tal cual en Arduino IDE 2 (carpeta del sketch con `DisplayStudio.ino` y sus `.h/.cpp`) y en PlatformIO (`platformio.ini` con entornos `esp32s3`, `esp32`, `esp32c3`, `nano_esp32` y `native` para los tests):
   - `proto/` (C++ puro): `crc16`, `parser` (máquina de estados incremental, sin bloqueos), `commands` (JSON mínimo; ArduinoJson 7 es aceptable fuera del camino de los frames), `pixel` (conversiones y rotación).
   - `displays/`: `Display.h`, `displays.cpp` (la tabla), una clase por familia y `GenericDrv` (adaptador de los drivers exportados por la app, con `drv_port_arduino.cpp` sobre `SPI`/`Wire`).
   - `touch/`: `Touch.h` y una clase por familia.
   - `config.h`: pines, buses, pantallas activadas y táctil, con comentarios.
2. `README.md`: qué placa y opciones elegir en el menú Herramientas (USB CDC On Boot, PSRAM, Partition Scheme, CPU 240 MHz), bibliotecas a instalar con sus versiones, tabla de cableado por pantalla y táctil, cómo añadir una pantalla creada en la app (clave, id, driver exportado) y solución de problemas (puerto no aparece o se reinicia al conectar, colores invertidos o BGR, imagen desplazada, e-paper que no refresca, táctil con ejes cambiados, texto basura en el LCD).
3. Un ejemplo `examples/SinApp/SinApp.ino` que dibuja un patrón de prueba en la pantalla de `config.h` sin la app, para comprobar el cableado.
4. **Tests en el PC** del parser y el CRC (Unity o un runner simple): CRC con el vector `0x29B1`; el parser con frames válidos, CRC erróneo, payload truncado, basura intercalada entre JSON y frames, JSON partido en varios bloques y dos frames seguidos. También las conversiones RGB565 → RGB666 / grises / páginas y las cuatro rotaciones, comparadas con valores conocidos.
5. `tools/send_test.py` (pyserial): envía `config`, un degradado RGB565 y un patrón mono con **este mismo protocolo** (incluido el CRC), para probar el firmware sin la app; acepta la clave de la pantalla como argumento.

## Criterios de aceptación

- La app conecta, el firmware responde `READY`, y `config` cambia entre las pantallas de la tabla sin reiniciar.
- Dibujar a mano en la app se refleja en el panel sin tearing visible; una animación de 10 fps en 240x240 RGB565 se mantiene sin desincronizarse durante 10 minutos.
- Un frame importado de Figma (por ejemplo, 240x240 en una GC9A01 o 128x64 en un SSD1306) se ve en el panel igual que en la vista previa de la app: mismos colores, misma orientación y mismo tramado en 1 bit.
- Frames con CRC inválido, tamaño incorrecto o display equivocado devuelven `ERR ...`, y el siguiente frame válido se muestra con normalidad.
- Una pantalla creada en la app con "Otro" driver funciona copiando su driver exportado desde Código C, implementando `drv_port.h` y añadiendo una fila a la tabla.
- Desenchufar y reconectar el cable no requiere reiniciar la placa.
- En el LCD, `lcd`, `glyph`, `glyphAt` y `lcdRaw` reproducen texto, glifos y animaciones sin parpadeo.
- Con táctil configurado, tocar las cuatro esquinas da coordenadas lógicas correctas en las cuatro rotaciones.

## Antes de escribir código

Si algo del protocolo o del hardware es ambiguo, **pregúntame primero**: placa exacta, pantallas y táctiles que voy a conectar, pines, y si hay PSRAM. Después entrega la estructura de archivos y el plan, y luego el código por módulos, empezando por el parser del protocolo y sus tests.
