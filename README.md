# URP Digital Signage — Cliente Raspberry Pi (`URPPI3.js`)

Cliente autónomo de cartelería digital para **Raspberry Pi 3B+, 4 y 5**, compatible con **Raspberry Pi OS Buster, Bullseye, Bookworm y Trixie (Debian 10/11/12/13)**.  
Se conecta al servidor Manager (`tbee.tv`), sincroniza horarios y contenidos por FTP reanudable, unifica videos e imágenes en reproducción continua **sin cortes ni pantalla negra (0 ms)** y se **auto-actualiza de forma remota desde este repositorio de GitHub**.

---

## ¿Qué hace esta aplicación?

- **Reproducción continua sin cortes (`Seamless Loop`):** Concatena automáticamente los videos e imágenes de cada bloque horario en un único stream MP4 continuo (`/home/pi/URP/seamless/`), evitando flashes negros o destellos del escritorio entre archivos.
- **Conversión automática de imágenes a video MP4:** Transforma `.jpg`, `.jpeg` y `.png` a H.264 (`1920x1080` o `1080x1920`) respetando la duración configurada en el Manager, en segundo plano y con escritura atómica (`temp_*`).
- **Descarga FTP reanudable (`curl`):** Descarga archivos grandes con soporte de reanudación (`-C -`), monitoreo de velocidad en Mbps y verificación MD5 de bajo consumo de memoria (con respaldo automático en `JSFtp`).
- **Motor dual por hardware:** Utiliza `omxplayer` en sistemas legacy (Buster/Bullseye) y `mpv` optimizado (`--hwdec=auto`, `--ontop`, playlist en ventana única) en sistemas modernos (Bookworm/Trixie y Pi 4/5).
- **Cortina negra y modo kiosko limpio:** Desactiva fondo de escritorio, barras de tareas (`lxpanel`/`wf-panel-pi`), salvapantallas, cursor y **todos los popups/notificaciones del sistema**.
- **Modo Offline resiliente:** Si se corta internet, continúa reproduciendo al instante la programación guardada localmente (`URPDB` / `URPDB.json` y contenido en disco).
- **Auto-actualización remota desde GitHub (OTA):** Cada **5 minutos** verifica si hay una versión nueva de `URPPI3.js` en `JulianDS95/URPSignageTv`, valida sintaxis con `node --check`, crea respaldo (`.bak`) y reinicia el servicio automáticamente.

---

## Archivos del repositorio

| Archivo | Descripción |
| :--- | :--- |
| `URPPI3.js` | Cliente principal de cartelería digital (`v2.3.0`), servidor HTTP local (`:8090`) y motor OTA. |
| `install-urp.sh` | Instalador automático *zero-touch* para Raspberry Pi recién flasheada. |
| `README.md` | Documentación completa de instalación, comandos, rotación e historial de mejoras. |

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
| Regenerar caché seamless | `rm -rf /home/pi/URP/seamless/* && pm2 restart URP` |
| Reiniciar la Raspberry Pi | `sudo reboot` |

### Endpoints HTTP locales (Puerto `8090`)
- `GET /play` · `GET /stop` · `GET /pause` · `GET /resetContent`
- `GET /deleteContents` · `GET /reboot` · `GET /shutdown`
- `GET /schedule` · `GET /contents` · `GET /update`
- `GET /URPTemperature` · `GET /URPmemPercentUsed` · `GET /URPcpuUsage`

---

## Historial de mejoras por actualización

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
