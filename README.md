# URP Digital Signage — Cliente Raspberry Pi (`URPPI3.js`)

Cliente autónomo de cartelería digital para **Raspberry Pi 3B+, 4 y 5**, compatible con **Raspberry Pi OS Buster, Bullseye, Bookworm y Trixie (Debian 10/11/12/13)**.  
Se conecta al servidor Manager (`tbee.tv`), sincroniza horarios y contenidos por FTP reanudable, unifica videos e imágenes en reproducción continua **sin cortes ni pantalla negra (0 ms)** y se **auto-actualiza de forma remota desde este repositorio de GitHub**.

---

## ¿Qué hace esta aplicación?

- **Reproducción continua sin cortes (`Seamless Loop`):** Concatena automáticamente los videos e imágenes de cada bloque horario en un único stream MP4 continuo (`/home/pi/URP/seamless/`), evitando flashes negros o destellos del escritorio entre archivos (con unión instantánea `-c copy` cuando los clips ya están estandarizados).
- **Optimización automática de cualquier video subido:** Analiza cada video nuevo con `ffprobe`; si supera la capacidad óptima de la Raspberry (4K, 60fps, HEVC/H.265, VP9, AV1, 10-bit, `>8.5 Mbps`, contenedores `.mov`/`.mkv`/`.webm`, etc.), lo normaliza automáticamente en segundo plano con prioridad baja (`nice -n 15`) a **H.264 8-bit ≤1080p @25fps (`/home/pi/URP/optimized/`)** sin bloquear la reproducción ni alterar el archivo original de `content/`.
- **Conversión automática de imágenes a video MP4:** Transforma `.jpg`, `.jpeg` y `.png` a H.264 (`1920x1080` o `1080x1920`) respetando la duración configurada en el Manager, en segundo plano y con escritura atómica (`temp_*`).
- **Descarga FTP reanudable (`curl`):** Descarga archivos grandes con soporte de reanudación (`-C -`), monitoreo de velocidad en Mbps y verificación MD5 de bajo consumo de memoria (con respaldo automático en `JSFtp`).
- **Motor dual por hardware:** Utiliza `omxplayer` en sistemas legacy (Buster/Bullseye) y `mpv` optimizado (`--hwdec=auto`, buffer RAM de 16 MB, `--framedrop=vo`, `--ontop`, playlist en ventana única) en sistemas modernos (Bookworm/Trixie y Pi 4/5).
- **Cortina negra y modo kiosko limpio:** Desactiva fondo de escritorio, barras de tareas (`lxpanel`/`wf-panel-pi`), salvapantallas, cursor y **todos los popups/notificaciones del sistema**.
- **Modo Offline resiliente:** Si se corta internet, continúa reproduciendo al instante la programación guardada localmente (`URPDB` / `URPDB.json` y contenido en disco).
- **Auto-actualización remota desde GitHub (OTA):** Cada **5 minutos** verifica si hay una versión nueva de `URPPI3.js` en `JulianDS95/URPSignageTv`, valida sintaxis con `node --check`, crea respaldo (`.bak`) y reinicia el servicio automáticamente.

---

## Archivos del repositorio

| Archivo | Descripción |
| :--- | :--- |
| `URPPI3.js` | Cliente principal de cartelería digital (`v2.4.1`), motor Video Wall por mosaico/espejo, servidor HTTP (`:8090`) y OTA. |
| `urp-wall.sh` | Configurador ejecutable independiente (`urp-wall`) para activar Video Wall, elegir ID, disposición y orientación. |
| `install-urp.sh` | Instalador automático *zero-touch* para Raspberry Pi recién flasheada. |
| `README.md` | Documentación completa de instalación, Video Wall, comandos, rotación e historial de mejoras. |

---

## Instalación rápida desde cero (1 solo comando)

Flasheá **Raspberry Pi OS (con escritorio)** en tu microSD, conectá la Raspberry a internet, abrí una terminal (o entrá por SSH) y ejecutá:

### Repositorio público
```bash
curl -fsSL "https://raw.githubusercontent.com/JulianDS95/URPSignageTv/main/install-urp.sh?t=$(date +%s)" | bash
```

### Repositorio privado *(usando Fine-grained Token de solo lectura)*
1. En GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Seleccioná únicamente este repositorio (`Only select repositories → URPSignageTv`) con permiso **Contents: Read-only**.
3. Ejecutá en la terminal de la Raspberry Pi:
```bash
export GITHUB_TOKEN="TU_TOKEN_SOLO_LECTURA"
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "https://raw.githubusercontent.com/JulianDS95/URPSignageTv/main/install-urp.sh?t=$(date +%s)" | bash
unset GITHUB_TOKEN
```

Al finalizar el instalador, reiniciá una vez para aplicar autologin gráfico y entorno X11:
```bash
sudo reboot
```

### ¿Qué configura automáticamente `install-urp.sh`?
1. Detecta modelo de Raspberry Pi (3B+, 4, 5), sistema operativo (Buster, Bullseye, Bookworm, Trixie) y usuario actual (crea enlace simbólico si no es `pi`).
2. Aplica fix automático de repositorios archivados en Raspbian Buster EOL e instala `curl`, `ffmpeg`, `feh`, `unclutter`, `x11-xserver-utils`, `mpv`/`omxplayer`, `nodejs`, `npm` y `pm2`.
3. Crea `/home/pi/URP/` (`content/`, `temp/`, `seamless/`, `web/`) e instala dependencias Node.js.
4. Descarga `URPPI3.js`, valida su sintaxis con `node --check` y lo registra en **PM2** con arranque automático al encender.
5. Activa **autologin gráfico (B4)**, fuerza **X11 (W1)** en Bookworm/Trixie, desactiva salvapantallas/DPMS y deja **comentada** la opción de rotación en `config.txt`.
6. **Bloquea popups y notificaciones** (`piwiz`, `xfce4-notifyd`, `notification-daemon`, `mako`, `dunst`, `update-notifier`, `blueman`, `nm-applet`, automontaje USB en `pcmanfm` y avisos OSD con `avoid_warnings=1`).
7. Habilita permisos `NOPASSWD` en `/etc/sudoers.d/urp` para reinicio y apagado remoto desde el Manager.

---

## Configurar orientación Vertical (90° o 270°)

El instalador ya deja la línea preparada y comentada en `config.txt`.

1. Abrí el archivo de configuración según tu versión de Raspberry Pi OS:
   - **Trixie / Bookworm:**
     ```bash
     sudo nano /boot/firmware/config.txt
     ```
   - **Buster / Bullseye:**
     ```bash
     sudo nano /boot/config.txt
     ```
2. Buscá al final del archivo la línea comentada y **quitale el `#`**:
   ```ini
   display_hdmi_rotate=1
   ```
   *(Usá `1` para **90° derecha**, `3` para **270° izquierda**, `2` para **180°** y `0` para **horizontal**.)*
3. Guardá con **`Ctrl + O` → `Enter`** y salí con **`Ctrl + X`**.
4. Activá también la opción **Vertical** en el panel de `tbee.tv` para este reproductor.
5. Limpiá la caché de concatenación previa (solo si ya había videos cacheados en horizontal) y reiniciá:
   ```bash
   rm -rf /home/pi/URP/seamless/* && sudo reboot
   ```

> **Nota para Trixie/Bookworm:** Aunque el kernel KMS moderno ignora `display_hdmi_rotate` en `config.txt`, `URPPI3.js` lee ese valor automáticamente y aplica la rotación vía `xrandr` / `wlr-randr` al iniciar, además de adaptar imágenes y videos `seamless` a `1080x1920`.

---

## Actualización remota automática (OTA desde GitHub)

Cada vez que subas una nueva versión de `URPPI3.js` a `JulianDS95/URPSignageTv`:
- Todas las Raspberry Pis activas verifican GitHub automáticamente a los **25 segundos** de encender y luego **cada 5 minutos**.
- Si el hash MD5 del archivo en GitHub difiere del local:
  1. Verifica que sea un script válido de `URPPI3` y comprueba sintaxis con `node --check`.
  2. Si hay un error de sintaxis, **aborta la actualización** y sigue reproduciendo sin interrupciones.
  3. Si es válido, guarda respaldo en `URPPI3.js.bak`, actualiza `URPPI3.js` y reinicia el servicio PM2 automáticamente.

> **Si el repositorio está en modo privado** y querés que las Pis se actualicen solas cada 5 min sin intervención, guardá tu token de solo lectura en el equipo:
> ```bash
> echo "TU_TOKEN_SOLO_LECTURA" > /home/pi/URP/.github_token && chmod 600 /home/pi/URP/.github_token
> ```

### Actualizar manualmente una Pi que tiene una versión anterior a `v2.3.0`
```bash
curl -fsSL "https://raw.githubusercontent.com/JulianDS95/URPSignageTv/main/URPPI3.js?t=$(date +%s)" -o /home/pi/URP/URPPI3.js && pm2 restart URP
```

---

## Comandos útiles de administración en la Raspberry Pi

| Acción | Comando |
| :--- | :--- |
| Ver logs en tiempo real | `pm2 logs URP` |
| Ver estado del proceso | `pm2 status` |
| Reiniciar reproductor | `pm2 restart URP` |
| Forzar chequeo OTA inmediato | `curl http://localhost:8090/update` |
| Ver programación actual | `curl http://localhost:8090/schedule` |
| Regenerar caché seamless/optimizada | `rm -rf /home/pi/URP/seamless/* /home/pi/URP/optimized/* && pm2 restart URP` |
| Reiniciar la Raspberry Pi | `sudo reboot` |

### Endpoints HTTP locales (Puerto `8090`)
- `GET /play` · `GET /stop` · `GET /pause` · `GET /resetContent`
- `GET /deleteContents` · `GET /reboot` · `GET /shutdown`
- `GET /schedule` · `GET /contents` · `GET /update`
- `GET /wall` · `GET /wall/sync`
- `GET /URPTemperature` · `GET /URPmemPercentUsed` · `GET /URPcpuUsage`

---

## Modo Video Wall (Ejecutable independiente `urp-wall`)

Por defecto (`wall.json` ausente o desactivado), la Raspberry Pi funciona **100% como `URPPI3` normal**.  
Cuando quieras armar un Video Wall de 2, 3, 4 o más pantallas **sin modificar el servidor `tbee.tv`**:

1. Ejecutá el configurador en cada Raspberry Pi:
   ```bash
   urp-wall
   ```
   *(Si instalaste antes de `v2.4.0`, descargalo primero una vez: `curl -fsSL "https://raw.githubusercontent.com/JulianDS95/URPSignageTv/main/urp-wall.sh?t=$(date +%s)" -o /home/pi/URP/urp-wall.sh && chmod +x /home/pi/URP/urp-wall.sh && sudo ln -sf /home/pi/URP/urp-wall.sh /usr/local/bin/urp-wall`.)*
2. En el menú interactivo configurás:
   - **Modo de activación:**
     - **Controlado por servidor `tbee.tv` (Remoto):** activás y desactivás el Video Wall directamente desde la opción **Video Wall** del panel de `tbee.tv` (sin volver a entrar por SSH).
     - **Siempre Activo (Local)** o **Desactivado (Modo Normal `URPPI3`)**.
   - **Disposición de pantallas y Modo:** presets rápidos (`1x2`, `1x3`, `1x4`, `2x1`, `3x1`, `2x2`, `3x3` o personalizado) en modo **Mosaico (`tile`)** para partir la imagen/video entre pantallas o **Espejo (`mirror`)** sincronizado.
   - **ID de pantalla (`1..N`):** muestra el mapa visual de la matriz e identifica automáticamente la fila/columna exacta que recorta esta Raspberry Pi.
   - **Orientación física:** Horizontal (`0°`), Vertical `90°`, Vertical `270°` o `180°` (sincronizado con `config.txt`).
   - **Compensación de bisel (`bezelPx`):** píxeles opcionales del marco entre pantallas vecinas.
   - **Sincronización:** **NTP automático** (sin equipo Master extra, todas alineadas al reloj del sistema) o **Master/Slave por IP local** (si la red no tiene internet).
3. **Subí un único video o imagen en `tbee.tv`:** asigná la misma campaña a todas las pantallas del wall; cada Raspberry Pi descarga el archivo original (manteniendo intacto el MD5 de `content/`), recorta su porción en `optimized/`/`seamless/` y sincroniza la reproducción vía IPC de `mpv`. *(Nota: si no configuraste `urp-wall` pero activás Video Wall en `tbee.tv`, la Pi entra automáticamente en modo Espejo sincronizado sin recorte.)*

### Características y requisitos de los contenidos para Video Wall

Para que todas las pantallas se mantengan perfectamente alineadas y sin deformaciones ni bandas negras inesperadas, tené en cuenta estas pautas al exportar y programar el contenido:

1. **Misma duración total (obligatorio):**
   - **Opción recomendada (1 archivo maestro):** Subí **un único video o imagen** y asignalo a todas las pantallas del Video Wall. Así todas reproducen exactamente la misma duración, cantidad de cuadros y loop sincronizado.
   - **Si usás archivos distintos por pantalla (modo `mirror` o piezas separadas):** Todos los videos del mismo bloque horario deben durar **exactamente lo mismo** (idéntica duración en segundos/milisegundos) y tener los mismos FPS (ej. `25 fps`). Si un video dura 15s y el de al lado dura 16s, el loop se desfasará en cada repetición.
   - **Múltiples elementos en un bloque:** Si un bloque combina varios videos o imágenes, todas las pantallas deben tener exactamente la misma lista, orden y duración por ítem para que el stream continuo (`seamless`) mida lo mismo en todas las Raspberry Pis.
2. **Resolución y proporción del archivo según la matriz (modo Mosaico `tile`):**
   - `URPPI3.js` recorta el archivo manteniendo la relación de aspecto real sin estirar ni deformar caras o logos. Diseñá el lienzo acorde a la disposición física de tus monitores:
   | Disposición | Orientación de cada monitor | Resolución ideal del archivo | Alternativa liviana |
   | :--- | :--- | :--- | :--- |
   | **`2x2` o `3x3`** | Horizontales (`16:9`) | `3840x2160` (4K) | `1920x1080` (Full HD) |
   | **`1x2`** | Horizontales (`16:9`) | `3840x1080` | `2560x720` |
   | **`1x3`** | Horizontales (`16:9`) | `5760x1080` | `3840x720` |
   | **`1x4`** | Horizontales (`16:9`) | `7680x1080` | `5120x720` |
   | **`1x3`** | **Verticales 90°/270° (`9:16`)** | `3240x1920` | `1920x1080` *(encaja casi exacto)* |
   | **`2x1`** | Horizontales apilados | `1920x2160` | `1280x1440` |
   | **`3x1`** | Horizontales apilados | `1920x3240` | `1280x2160` |
   | **Espejo (`mirror`)** | Cualquiera | `1920x1080` (H) o `1080x1920` (V) | `1280x720` (H) / `720x1280` (V) |
3. **Formato técnico recomendado:**
   - **Contenedor y códec:** MP4 (**H.264 / AVC**, perfil Main/High `yuv420p` 8-bit) a **25 fps** constantes (CBR o VBR ≤15 Mbps, *keyframe* cada 1 segundo / 25 cuadros).
   - **Audio:** AAC estéreo `44.1 kHz` o sin pista de audio (en bloques mixtos conviene mismo formato en todos los clips).
   - *(Aunque `URPPI3.js` convierte automáticamente formatos pesados como 4K, 60fps, HEVC, `.mov` o `.mkv`, subir H.264 a 25fps reduce el tiempo inicial de recorte en cada Pi.)*
4. **Márgenes de bisel y alineación:**
   - Si configuraste compensación de bisel (`bezelPx > 0` en `urp-wall`), evitá ubicar tipografías pequeñas o líneas finas justo en los bordes de corte entre pantallas vecinas.
   - Al publicar una campaña nueva, esperá unos instantes mientras cada Raspberry termina el recorte en segundo plano (`/home/pi/URP/optimized/`); una vez generado el MP4 recortado, `mpv` ajusta la deriva automáticamente en el siguiente ciclo (`curl http://localhost:8090/wall` para verificar).
5. **Requisitos de reloj, horarios en `tbee.tv` y red:**
   - **Agenda individual en `tbee.tv` (entornos mixtos):** Cada televisor conserva su carga y agenda horaria propia en `tbee.tv`. Podés tener pantallas **independientes** (sin activar `urp-wall`, respetando sus propios horarios) conviviendo con un grupo en **Video Wall** (por ejemplo, TV 3 y TV 4 con `urp-wall` activo). En las pantallas del Video Wall simplemente replicá la misma agenda (mismos bloques horarios y orden de contenidos) en `tbee.tv`; la sincronización y los cambios de bloque cada 5s actuarán únicamente entre ellas.
   - **Modo NTP (sin Master):** Todas las Pis deben tener acceso a internet (o a un servidor NTP local) para mantener sincronizado el reloj del sistema.
   - **Modo Master/Slave LAN:** Todas las Pis deben estar en la misma red local con el puerto `8090` accesible hacia la IP del Master.

---

## Historial de mejoras por actualización

### `v2.4.1` — Reproducción de video ultra fluida (`mpv` X11/GPU + Baseline L3.1)
- **Escalado GPU liviano y decodificación rápida en `mpv`:** Configurados `--scale=bilinear --cscale=bilinear --dscale=bilinear --dither-depth=no --deband=no --vd-lavc-fast --vd-lavc-skiploopfilter=nonref --audio-fallback-to-null=yes` sobre `--vo=gpu`, reduciendo drásticamente el uso de CPU/GPU al decodificar y escalar en Raspberry Pi 3B+, 4 y 5.
- **Sin compositor X11 en segundo plano:** `suppressDesktopPopups()` ahora cierra también `xcompmgr`, `picom` y `compton` para que `mpv` dibuje directo a pantalla sin sobrecarga de composición ni *stutter*.
- **Perfil H.264 Baseline L3.1 en Pi 3B+ / Zero 2W y tope de 25 fps:** `needsPiVideoOptimization()` normaliza videos de `30/60 fps` a `25 fps` constantes y convierte cualquier video `High` o pesado en Pi 3B+ a **H.264 Constrained Baseline L3.1** (`720p`, `≤2.5 Mbps`, sin B-frames, 1 hilo seguro). En Pi 4/5 ajusta el bitrate objetivo a `4.2 Mbps` (`maxBps ≤ 6 Mbps`).
- **Regeneración automática de caché (`_p2`):** El sufijo `_p2.mp4` en `optimized/` fuerza la re-optimización automática en segundo plano de videos previamente procesados con perfiles más pesados, limpiando los archivos anteriores.

### `v2.4.0` — Video Wall autónomo + Control remoto `tbee.tv` + Configurador ejecutable (`urp-wall`)
- **Ejecutable independiente `urp-wall` (`/home/pi/URP/urp-wall.sh`):** Menú interactivo CLI con diagrama ASCII de la matriz para elegir activación (**Remoto desde `tbee.tv`**, **Local siempre activo** o **Desactivado**), definir disposición (`filas x columnas`), ID de pantalla, modo mosaico vs espejo, compensación de bisel, orientación (`config.txt`) y sincronización sin alterar el funcionamiento normal cuando está apagado.
- **Activación/desactivación remota desde `tbee.tv`:** `URPPI3.js` lee en vivo el campo `data.videoWall` del servidor y enciende o apaga el Video Wall automáticamente en cada pantalla (usando la matriz/ID guardada en `wall.json`, o modo espejo sincronizado si no hay `wall.json`).
- **Motor de recorte automático por pantalla en `URPPI3.js`:** Recorta videos e imágenes en segundo plano (`optimized/` y `seamless/`) según fila, columna y bisel configurados en `wall.json`, manteniendo intacto el archivo original en `content/`.
- **Sincronización de cuadros sin Master (NTP) y Master/Slave LAN:** Usa el socket IPC de `mpv` (`/tmp/mpv-urp.sock`) para corregir micro-derivas ajustando suavemente la velocidad (`0.97x / 1.03x`) sin pantallazos negros, más endpoints `GET /wall` y `GET /wall/sync`.
- **Instalador y OTA ampliados:** `install-urp.sh` y el actualizador OTA sincronizan automáticamente `urp-wall.sh` e instalan el comando global `urp-wall`.

### `v2.3.4` — Corrección de conversión `ffmpeg` y estabilidad de `mpv` (Restore + 720p Pi 3B+)
- **Corrección crítica de codificación `ffmpeg`:** Eliminado conflicto `-profile:v main -tune fastdecode` (que impedía inicializar `libx264` al convertir imágenes, videos optimizados y bloques `seamless`) y reemplazado `ionice` por `nice -n 15` con respaldo automático.
- **Restauración de `mpv` estable:** Vuelve a `--hwdec=auto --cache=yes --demuxer-max-bytes=16M --demuxer-max-back-bytes=4M --framedrop=vo` eliminando flags experimentales incompatibles y registrando cualquier error real en `pm2 logs URP`.
- **Mantiene optimización adaptativa y fin de `Drawing desktop`:** Pi 3B+ (`mpv`) normaliza automáticamente a `1280x720` (`-threads 1`), Pi 4/5 mantiene `1920x1080`, y el escritorio `pcmanfm`/`lwrespawn` queda desactivado sin bucles.

### `v2.3.3` — Fin del cartel "Drawing desktop" y resolución adaptativa Pi 3B+
- Neutralización permanente de `pcmanfm --desktop`, `lwrespawn`, `lxpanel` y `wf-panel-pi` en todos los perfiles (`rpd-x`, `LXDE-pi-x`, `LXDE-pi`, `labwc`, `~/.config/autostart`).
- Optimización adaptativa a `1280x720` (`720x1280` vertical) en Pi 3B+ con `mpv` y `1920x1080` en Pi 4/5.

### `v2.3.2` — Reproducción fluida universal de videos (Auto-normalización inteligente)
- **Motor de optimización automática en segundo plano (`/home/pi/URP/optimized/`):** Inspecciona cada video con `ffprobe` (códec, perfil, `pix_fmt`, resolución, FPS, bitrate y audio). Si ya es MP4 H.264 8-bit ≤1080p ≤32fps ≤8.5 Mbps, lo reproduce directo sin gastar CPU. Si es pesado (4K, 60fps, HEVC/H.265, VP9, AV1, 10-bit, `>8.5 Mbps`, `.mov`/`.mkv`/`.webm`), lo transcodifica en segundo plano con prioridad baja (`nice -n 15`, `-threads 2`, H.264 Main L4.0 `yuv420p`, max `5.5 Mbps`, `+faststart`) sin bloquear la pantalla ni tocar `content/` (mantiene intacto el MD5 del FTP).
- **Tuning anti-tirones en `mpv`:** Agregados `--cache=yes`, `--demuxer-max-bytes=16M`, `--demuxer-max-back-bytes=4M`, `--hr-seek=no`, `--framedrop=vo`, `--sws-scaler=fast-bilinear` y `--vd-lavc-threads=2`.
- **Unión `seamless` instantánea (`-c copy`):** Cuando todos los clips de un bloque ya están estandarizados a la resolución/FPS objetivo, `ffmpeg` los une sin re-codificar en menos de un segundo.
- Soporte ampliado de formatos de entrada: `.mp4`, `.mkv`, `.avi`, `.mov`, `.webm`, `.m4v`, `.ts`, `.mpg`, `.mpeg`, `.wmv`, `.flv`.

### `v2.3.1` — Motor de rotación de 3 niveles (garantizado en Trixie/Wayland/X11)
- Detección automática del estado físico de la salida HDMI (`xrandr` X11 + `wlr-randr` Wayland con auto-descubrimiento de `XDG_RUNTIME_DIR`/`WAYLAND_DISPLAY`).
- Respaldo automático por GPU dentro de `mpv` (`--video-rotate=90|180|270`) si el driver del sistema operativo no giró la pantalla física, garantizando rotación real del contenido incluso en XWayland o Pi 3B+ KMS.
- Instalación automática de `wlr-randr` en `install-urp.sh`.

### `v2.3.0` — Auto-actualización OTA desde GitHub
- Agregado motor de actualización remota automática contra `JulianDS95/URPSignageTv` (chequeo inicial a los 25s y periódico cada 5 minutos).
- Comparación por MD5 + validación previa con `node --check` + respaldo automático `URPPI3.js.bak` + reinicio limpio por PM2.
- Nuevo endpoint `GET /update` para forzar actualización remota al instante y soporte de token privado en `/home/pi/URP/.github_token`.

### `v2.2.2` — Rotación universal desde `config.txt` y bloqueo total de popups
- `URPPI3.js` ahora lee `display_hdmi_rotate` desde `/boot/firmware/config.txt` (o `/boot/config.txt`) y aplica la rotación automáticamente en Trixie/Bookworm mediante `xrandr` y `wlr-randr`, adaptando renders a `1080x1920` sin doble rotación en Buster.
- Bloqueo completo de notificaciones y popups del sistema (`piwiz`, `xfce4-notifyd`, `notification-daemon`, `mako`, `dunst`, `update-notifier`, `blueman`, `nm-applet`, automontaje USB de `pcmanfm`, paneles `lxpanel`/`wf-panel-pi` y `avoid_warnings=1`).

### `v2.2.1` — Compatibilidad total con Raspberry Pi OS Trixie (Debian 13) y Node 20+
- Corregida extensión temporal (`.tmp.js` y `.new.js`) para compatibilidad con `node --check` en Node.js 20/22+.
- Adaptador de base de datos compatible con `level` v6/v7, v8/v9/v10 y respaldo atómico en `URPDB.json`.
- Respaldo `createDecipheriv` (`EVP_BytesToKey`) para compatibilidad criptográfica en Node 22+.
- Optimización de `mpv` en Pi 3B+ (`--hwdec=auto`, `--ontop`, `--cursor-autohide=always`, playlist en ventana única) y gestión de memoria CMA sin desperdicio de RAM.

### `v2.2.0` — Instalador automático Zero-Touch y motor FTP con `curl`
- Creación de `install-urp.sh` compatible con Pi 3B+, 4 y 5, Buster EOL, Bookworm, Trixie, usuarios no-`pi` y repositorios GitHub públicos/privados (con bypass de caché CDN).
- Descargas FTP migradas a `curl --ftp-pasv -C -` reanudable, cálculo MD5 por streaming (1 MB chunks) y respaldo `JSFtp` con timeout de 15s.

### `v2.1.0` / `v2.0.0` — Reproducción continua 0 ms y estabilidad crítica
- Concatenación automática de bloques horarios (`seamless/`) en un único MP4 continuo con `ffmpeg filter_complex` + `ffprobe` y telemetría sincronizada por duración.
- Cortina negra permanente en X11 con `feh` (`black_curtain.png`) y neutralización del fondo de PCManFM.
- Conversión asíncrona/atómica de imágenes (`spawn`, `-threads 2`, dimensiones pares `trunc(iw/2)*2`, auto-reparación de MP4 corruptos).
- Eliminación de race condition en `killall -9` con `killMediaPlayersSync()`, unificación de nombres con espacios/guiones bajos y limpieza inteligente de disco sin borrar campañas activas.
