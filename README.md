# URP Digital Signage — Cliente Raspberry Pi (`URPPI3-v2.5.js`)

Cliente autónomo de cartelería digital para **Raspberry Pi 3B+, 4 y 5**, compatible con **Raspberry Pi OS Buster, Bullseye, Bookworm y Trixie (Debian 10/11/12/13)**.  
Se conecta al servidor Manager (`tbee.tv`), sincroniza horarios y contenidos por FTP reanudable, unifica videos e imágenes en reproducción continua **sin cortes ni pantalla negra (0 ms)**, se supervisa en vivo desde el puerto `:8090` y se **auto-actualiza de forma remota desde este repositorio de GitHub**.

---

## ¿Qué hace esta aplicación?

- **Reproducción continua sin cortes (`Seamless Loop`):** Concatena automáticamente los videos e imágenes de cada bloque horario en un único stream MP4 continuo (`/home/pi/URP/seamless/`), evitando flashes negros o destellos del escritorio entre archivos (con unión instantánea `-c copy` cuando los clips ya están estandarizados).
- **Resolución 720p fluida automática en Raspberry Pi 3B+ (`1280x720 @ 24fps`):** En equipos con <=1.5 GB de RAM (`Pi 3B+` / `Zero 2W`), normaliza videos e imágenes a `1280x720` H.264 Baseline `≤2.2 Mbps` (y ajusta automáticamente HDMI/X11 a `1280x720`), reduciendo más de un 55% el uso de CPU/RAM; en Pi 4 y 5 mantiene `1920x1080`. También podés elegir manualmente `Automática / 720p / 1080p` desde el panel web `:8090`.
- **Optimización automática de cualquier video subido:** Analiza cada video nuevo con `ffprobe` y lo normaliza en segundo plano con prioridad mínima (`nice -n 19`, pausa preventiva si la RAM >=86% o temperatura >=78 °C) en `/home/pi/URP/optimized/`, con padding exacto y pista AAC estéreo para garantizar unión `-c copy` sin re-codificar el bloque entero.
- **Panel Web Local y Remoto (`:8090`):**
  - Título dinámico sincronizado con el nombre asignado al reproductor en el Manager (`tbee.tv`).
  - **Monitor Visual en Vivo** (`GET /api/preview.jpg`): muestra en tiempo real lo que se ve en pantalla (cada 2s/3s/5s) sin subir capturas al FTP, junto a la barra de progreso actual (`mpv` IPC) y botón **Reiniciar Reproductor**.
  - **Resolución de conversión y Rotación directa:** permite cambiar entre `Automática / 720p / 1080p`, activar ajuste HDMI `1280x720` y rotar contenido/pantalla (`0° / 90° / 180° / 270°`) desde el panel principal.
  - **Agenda Cargada:** lista todos los bloques horarios activos, horario de inicio, duración y estado (`Listo` / `Pendiente`) de cada video o imagen.
  - **Configurador de Video Wall:** soporta IDs `1..999` y matrices hasta `32x32`.
- **Hostname sincronizado desde el Manager:** actualiza automáticamente el hostname del sistema operativo (`hostnamectl`) y el nombre en Tailscale (`tailscale set --hostname`) tomando el nombre configurado en `tbee.tv`.
- **Descarga FTP reanudable (`curl`):** Descarga archivos grandes con soporte de reanudación (`-C -`), monitoreo de velocidad en Mbps y verificación MD5 de bajo consumo de memoria (con respaldo automático en `JSFtp`).
- **Motor dual por hardware / DRM:** Utiliza `omxplayer` en sistemas legacy (Buster/Bullseye) o `mpv` optimizado en X11/Wayland/DRM-KMS directo (`--hwdec=auto`, búfer RAM reducido en Pi 3B+, `--framedrop=vo`, `--ontop`).
- **Cortina negra y modo kiosko limpio:** Desactiva fondo de escritorio, barras de tareas (`lxpanel`/`wf-panel-pi`), salvapantallas, cursor y **todos los popups/notificaciones del sistema**.
- **Modo Offline resiliente:** Si se corta internet, continúa reproduciendo al instante la programación guardada localmente (`URPDB` / `URPDB.json` y contenido en disco).
- **Auto-actualización remota desde GitHub (OTA con rollback):** Cada **5 minutos** verifica si hay una versión nueva de `URPPI3-v2.5.js` en `JulianDS95/URPSignageTv`, valida sintaxis con `node --check`, crea respaldo (`.bak`) y aplica rollback automático ante cualquier fallo de arranque en los primeros 20 segundos.

---

## Archivos del repositorio

| Archivo | Descripción |
| :--- | :--- |
| `URPPI3-v2.5.js` | **Base activa (`v2.5.0`):** Cliente principal, optimización 720p/1080p, panel web `:8090` con Monitor en Vivo, rotación, agenda, hostname automático, Video Wall sin límite y OTA con rollback. |
| `URPPI3.js` | Versión legado estable (`v2.4.1`). |
| `urp-wall.sh` | Configurador ejecutable independiente (`urp-wall`) para activar Video Wall, elegir ID (`1..999`), disposición (`hasta 32x32`) y orientación. |
| `install-urp.sh` | Instalador automático *zero-touch* para Raspberry Pi recién flasheada. |
| `README.md` | Documentación completa de instalación, Tailscale, panel `:8090`, Video Wall, comandos e historial de mejoras. |

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
3. Crea `/home/pi/URP/` (`content/`, `temp/`, `seamless/`, `optimized/`, `web/`) e instala dependencias Node.js (sin `request`).
4. Descarga `URPPI3-v2.5.js`, valida su sintaxis con `node --check` y lo registra en **PM2** con arranque automático al encender.
5. Activa **autologin gráfico (B4)**, fuerza **X11 (W1)** en Bookworm/Trixie, desactiva salvapantallas/DPMS y deja **comentada** la opción de rotación en `config.txt`.
6. **Bloquea popups y notificaciones** (`piwiz`, `xfce4-notifyd`, `notification-daemon`, `mako`, `dunst`, `update-notifier`, `blueman`, `nm-applet`, automontaje USB en `pcmanfm` y avisos OSD con `avoid_warnings=1`).
7. Habilita permisos `NOPASSWD` en `/etc/sudoers.d/urp` para reinicio, apagado, `hostnamectl` y `tailscale`.

---

## Acceso remoto con Tailscale (Panel `:8090` y SSH desde cualquier red)

Para instalar Tailscale y vincular la Raspberry Pi directamente con tu cuenta (reemplazando `tv1hjumbo` por el nombre del televisor/sucursal si lo hacés de forma manual):

```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --hostname=tv1hjumbo
```

1. Al ejecutar el comando, la terminal mostrará una URL corta (`https://login.tailscale.com/a/...`).
2. Abrí esa URL desde el navegador de tu celular o PC logueado en tu cuenta de Tailscale y aprobá el dispositivo (solo se hace una única vez).
3. Luego, desde cualquier PC o celular conectado a tu misma red de Tailscale, abrí el panel de mantenimiento y vista en vivo ingresando:
   ```
   http://IP_TAILSCALE_DE_LA_PI:8090
   ```
   *(Ejemplo: `http://100.126.132.77:8090`. Una vez que el cliente `URPPI3-v2.5.js` se conecta a `tbee.tv`, sincroniza automáticamente el hostname del sistema y de Tailscale con el nombre asignado en el Manager.)*

---

## Configurar orientación Vertical (90° o 270°) o Resolución (720p / 1080p)

Podés hacerlo directamente **sin entrar por SSH** desde el panel web `:8090` en la tarjeta **Resolución de Conversión y Rotación de Pantalla**, o manualmente editando `config.txt`:

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
   rm -rf /home/pi/URP/seamless/* /home/pi/URP/optimized/* && sudo reboot
   ```

> **Nota para Trixie/Bookworm:** Aunque el kernel KMS moderno ignora `display_hdmi_rotate` en `config.txt`, `URPPI3-v2.5.js` lee ese valor (o el elegido desde `:8090`) automáticamente y aplica la rotación vía `xrandr` / `wlr-randr` / `--video-rotate`, además de adaptar imágenes y videos a la resolución configurada (`720x1280` en 720p o `1080x1920` en 1080p).

---

## Actualización remota automática (OTA desde GitHub)

Cada vez que subas una nueva versión de `URPPI3-v2.5.js` a `JulianDS95/URPSignageTv`:
- Todas las Raspberry Pis activas verifican GitHub automáticamente a los **25 segundos** de encender y luego **cada 5 minutos**.
- Si el hash MD5 del archivo en GitHub difiere del local:
  1. Verifica que sea un script válido de `URPPI3` y comprueba sintaxis con `node --check`.
  2. Si hay un error de sintaxis, **aborta la actualización** y sigue reproduciendo sin interrupciones.
  3. Si es válido, guarda respaldo en `.bak`, actualiza el script y reinicia el servicio PM2 automáticamente con protección *rollback*.

> **Si el repositorio está en modo privado** y querés que las Pis se actualicen solas cada 5 min sin intervención, guardá tu token de solo lectura de GitHub en el equipo:
> ```bash
> echo "TU_TOKEN_SOLO_LECTURA" > /home/pi/URP/.github_token && chmod 600 /home/pi/URP/.github_token
> ```

### Actualizar manualmente una Pi que tiene una versión anterior a `v2.5.0`
```bash
curl -fsSL "https://raw.githubusercontent.com/JulianDS95/URPSignageTv/main/URPPI3-v2.5.js?t=$(date +%s)" -o /home/pi/URP/URPPI3-v2.5.js && pm2 delete URP 2>/dev/null || true && DISPLAY=:0 XAUTHORITY=/home/pi/.Xauthority pm2 start /home/pi/URP/URPPI3-v2.5.js --name URP && pm2 save
```

---

## Comandos útiles de administración en la Raspberry Pi

| Acción | Comando |
| :--- | :--- |
| Abrir panel web local / remoto | `http://IP_DE_LA_PI:8090` |
| Ver logs en tiempo real | `pm2 logs URP` |
| Ver estado del proceso | `pm2 status` |
| Reiniciar reproductor | `pm2 restart URP` |
| Forzar chequeo OTA inmediato | `curl http://localhost:8090/update` |
| Ver programación actual | `curl http://localhost:8090/schedule` |
| Regenerar caché seamless/optimizada | `rm -rf /home/pi/URP/seamless/* /home/pi/URP/optimized/* && pm2 restart URP` |
| Reiniciar la Raspberry Pi | `sudo reboot` |

### Endpoints HTTP locales (Puerto `8090`)
- `GET /` (Panel web completo) · `GET /api/status` · `GET /api/preview.jpg`
- `POST /api/display-settings` · `POST /api/wall`
- `GET /restartPlayer` · `GET /resetContent` · `GET /gc`
- `GET /deleteContents` · `GET /reboot` · `GET /shutdown`
- `GET /schedule` · `GET /contents` · `GET /update`
- `GET /wall` · `GET /wall/sync` · `GET /cleanLogs` · `GET /uploadLogs`
- `GET /URPTemperature` · `GET /URPmemPercentUsed` · `GET /URPcpuUsage`

---

## Modo Video Wall (Ejecutable independiente `urp-wall`)

Por defecto (`wall.json` ausente o desactivado), la Raspberry Pi funciona **100% como `URPPI3` normal**.  
Cuando quieras armar un Video Wall de 2, 3, 4 o más pantallas **sin modificar el servidor `tbee.tv`**:

1. Ejecutá el configurador en cada Raspberry Pi (o entrá desde el panel web `:8090` → **Configurar Video Wall**):
   ```bash
   urp-wall
   ```
   *(Si instalaste antes de `v2.4.0`, descargalo primero una vez: `curl -fsSL "https://raw.githubusercontent.com/JulianDS95/URPSignageTv/main/urp-wall.sh?t=$(date +%s)" -o /home/pi/URP/urp-wall.sh && chmod +x /home/pi/URP/urp-wall.sh && sudo ln -sf /home/pi/URP/urp-wall.sh /usr/local/bin/urp-wall`.)*
2. En el menú interactivo configurás:
   - **Modo de activación:**
     - **Controlado por servidor `tbee.tv` (Remoto):** activás y desactivás el Video Wall directamente desde la opción **Video Wall** del panel de `tbee.tv` (sin volver a entrar por SSH).
     - **Siempre Activo (Local)** o **Desactivado (Modo Normal `URPPI3`)**.
   - **Disposición de pantallas y Modo:** presets rápidos (`1x2`, `1x3`, `1x4`, `1x5`, `1x6`, `2x1`, `2x2`, `2x3`, `3x3` o personalizado hasta `32x32`) en modo **Mosaico (`tile`)** para partir la imagen/video entre pantallas o **Espejo (`mirror`)** sincronizado.
   - **ID de pantalla (`1..999`):** muestra el mapa visual de la matriz e identifica automáticamente la fila/columna exacta que recorta esta Raspberry Pi.
   - **Orientación física:** Horizontal (`0°`), Vertical `90°`, Vertical `270°` o `180°` (sincronizado con `config.txt`).
   - **Compensación de bisel (`bezelPx`):** píxeles opcionales del marco entre pantallas vecinas.
   - **Sincronización:** **NTP automático** (sin equipo Master extra, todas alineadas al reloj del sistema) o **Master/Slave por IP local** (si la red no tiene internet).
3. **Subí un único video o imagen en `tbee.tv`:** asigná la misma campaña a todas las pantallas del wall; cada Raspberry Pi descarga el archivo original (manteniendo intacto el MD5 de `content/`), recorta su porción en `optimized/`/`seamless/` y sincroniza la reproducción vía IPC de `mpv`. *(Nota: si no configuraste `urp-wall` pero activás Video Wall en `tbee.tv`, la Pi entra automáticamente en modo Espejo sincronizado sin recorte.)*

### Características y requisitos de los contenidos para Video Wall

Para que todas las pantallas se mantengan perfectamente alineadas y sin deformaciones ni bandas negras inesperadas, tené en cuenta estas pautas al exportar y programar el contenido:

1. **Misma duración total (obligatorio):**
   - **Opción recomendada (1 archivo maestro):** Subí **un único video o imagen** y asignalo a todas las pantallas del Video Wall. Así todas reproducen exactamente la misma duración, cantidad de cuadros y loop sincronizado.
   - **Si usás archivos distintos por pantalla (modo `mirror` o piezas separadas):** Todos los videos del mismo bloque horario deben durar **exactamente lo mismo** (idéntica duración en segundos/milisegundos) y tener los mismos FPS (ej. `24/25 fps`). Si un video dura 15s y el de al lado dura 16s, el loop se desfasará en cada repetición.
   - **Múltiples elementos en un bloque:** Si un bloque combina varios videos o imágenes, todas las pantallas deben tener exactamente la misma lista, orden y duración por ítem para que el stream continuo (`seamless`) mida lo mismo en todas las Raspberry Pis.
2. **Resolución y proporción del archivo según la matriz (modo Mosaico `tile`):**
   - `URPPI3-v2.5.js` recorta el archivo manteniendo la relación de aspecto real sin estirar ni deformar caras o logos. Diseñá el lienzo acorde a la disposición física de tus monitores:
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
   - **Contenedor y códec:** MP4 (**H.264 / AVC**, perfil Baseline/Main `yuv420p` 8-bit) a **24/25 fps** constantes (CBR o VBR ≤15 Mbps, *keyframe* cada 1 segundo).
   - **Audio:** AAC estéreo `44.1 kHz` o sin pista de audio.
   - *(Aunque `URPPI3-v2.5.js` convierte automáticamente formatos pesados como 4K, 60fps, HEVC, `.mov` o `.mkv`, subir H.264 a 24/25fps reduce el tiempo inicial de recorte en cada Pi.)*
4. **Márgenes de bisel y alineación:**
   - Si configuraste compensación de bisel (`bezelPx > 0` en `urp-wall`), evitá ubicar tipografías pequeñas o líneas finas justo en los bordes de corte entre pantallas vecinas.
   - Al publicar una campaña nueva, esperá unos instantes mientras cada Raspberry termina el recorte en segundo plano (`/home/pi/URP/optimized/`); una vez generado el MP4 recortado, `mpv` ajusta la deriva automáticamente en el siguiente ciclo (`curl http://localhost:8090/wall` para verificar).
5. **Requisitos de reloj, horarios en `tbee.tv` y red:**
   - **Agenda individual en `tbee.tv` (entornos mixtos):** Cada televisor conserva su carga y agenda horaria propia en `tbee.tv`. Podés tener pantallas **independientes** (sin activar `urp-wall`, respetando sus propios horarios) conviviendo con un grupo en **Video Wall** (por ejemplo, TV 3 y TV 4 con `urp-wall` activo). En las pantallas del Video Wall simplemente replicá la misma agenda (mismos bloques horarios y orden de contenidos) en `tbee.tv`; la sincronización y los cambios de bloque cada 5s actuarán únicamente entre ellas.
   - **Modo NTP (sin Master):** Todas las Pis deben tener acceso a internet (o a un servidor NTP local) para mantener sincronizado el reloj del sistema.
   - **Modo Master/Slave LAN:** Todas las Pis deben estar en la misma red local con el puerto `8090` accesible hacia la IP del Master.

---

## Historial de mejoras por actualización

### `v2.5.0` — Panel Completo en Vivo (`:8090`), 720p Fluido Pi 3B+, Rotación/Agenda y Tailscale
- **Controles directos en el panel principal `:8090`:**
  - Selector de **Resolución de conversión** (`Automática / 1280x720 / 1920x1080` + ajuste automático de salida HDMI/X11 a `1280x720`).
  - Selector de **Rotación de contenido / pantalla** (`0° / 90° / 180° / 270°`) operativo incluso sin Video Wall activo ni permisos de escritura sobre `config.txt`.
  - Sección **Agenda Cargada** en vivo con bloques horarios, horario de inicio, bloque activo, duración y estado (`Listo` / `Pendiente`) de cada contenido.
  - **Monitor Visual en Vivo** (`/api/preview.jpg`) sin subidas FTP + barra de progreso en vivo desde `mpv` IPC + botón **Reiniciar Reproductor** y título dinámico con el nombre del Manager.
- **Reproducción fluida 720p y bajo uso de CPU/RAM en Pi 3B+:**
  - Resolución objetivo `1280x720 @ 24fps` (H.264 Baseline L3.1 `≤2.2 Mbps`) por defecto en equipos <=1.5 GB RAM tanto para videos como imágenes (`_720p`).
  - Padding exacto y pista de audio AAC estéreo `44.1 kHz` garantizados en `optimized/` (`_p3.mp4`) para que la unión `seamless` use **`-c copy` instantáneo (~0% CPU)** en vez de re-codificar bloques completos.
  - Búfer reducido en `mpv` (`6M`/`1M`, 2 hilos), prioridad mínima (`nice -n 19`), `-preset ultrafast` y pausa preventiva de `ffmpeg` ante RAM >=86% o temperatura >=78 °C.
- **Hostname automático y Tailscale:**
  - Sincronización automática del hostname Linux y de Tailscale desde el nombre asignado en `tbee.tv`, más instalación de Tailscale integrada en `install-urp.sh` y guía directa sin tokens en este README.
- **Video Wall sin límite de 3 pantallas y navegación mejorada:**
  - Configurador CLI (`urp-wall.sh`) y web (`:8090`) ampliados a IDs `1..999`, matrices hasta `32x32`, botón *Volver atrás* en todos los submenús y rollback OTA automático (`.ota_pending`).

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
