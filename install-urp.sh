#!/bin/bash
# ==============================================================================
# Instalador Automático Zero-Touch - URP Digital Signage v2.5.7
# Compatible con Raspberry Pi 3B+ (Buster/Legacy) y Raspberry Pi 4 / 5 (Bullseye/Bookworm/Trixie)
# Uso desde GitHub público:
#   curl -fsSL https://raw.githubusercontent.com/JulianDS95/URPSignageTv/main/install-urp.sh | bash
# Acceso remoto Tailscale (sin token/key):
#   curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --hostname=tv1hjumbo
# Uso desde GitHub PRIVADO (con Fine-Grained Token solo lectura "Contents: Read-only"):
#   export GITHUB_TOKEN="github_pat_TU_TOKEN"
#   curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/JulianDS95/URPSignageTv/main/install-urp.sh | bash
#   unset GITHUB_TOKEN
# ==============================================================================
set -e

DEFAULT_GITHUB_REPO="JulianDS95/URPSignageTv"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
URP_SCRIPT_FILE="${URP_SCRIPT_FILE:-URPPI3-v2.5.js}"
URP_TAILSCALE="${URP_TAILSCALE:-1}"
ARG_SOURCE="${1:-}"

if [ -n "$ARG_SOURCE" ]; then
    case "$ARG_SOURCE" in
        http://*|https://*) URP_SOURCE_URL="$ARG_SOURCE" ;;
        */*) GITHUB_REPO="$ARG_SOURCE" ;;
    esac
fi

GITHUB_REPO="${GITHUB_REPO:-$DEFAULT_GITHUB_REPO}"
if [ -z "${URP_SOURCE_URL:-}" ] && [ -n "$GITHUB_REPO" ]; then
    URP_SOURCE_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${URP_SCRIPT_FILE}"
fi
URP_SOURCE_URL="${URP_SOURCE_URL:-http://tbee.tv/URP/${URP_SCRIPT_FILE}}"

if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    TARGET_USER="$SUDO_USER"
    TARGET_HOME="$(eval echo ~"$SUDO_USER")"
else
    TARGET_USER="$(whoami)"
    TARGET_HOME="$HOME"
fi

echo "=========================================================="
echo "  Instalador Automático URP Digital Signage (v2.5.7)"
echo "  Usuario detectado: $TARGET_USER ($TARGET_HOME)"
echo "=========================================================="

# 1. Detectar modelo de Raspberry Pi y versión de OS
PI_MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo 'Raspberry Pi')"
OS_CODENAME="$(. /etc/os-release 2>/dev/null && echo "$VERSION_CODENAME" || echo 'unknown')"
echo "[1/7] Hardware: $PI_MODEL | Sistema: $OS_CODENAME"

# Si el usuario no se llama 'pi', asegurar compatibilidad con /home/pi/URP
if [ "$TARGET_USER" != "pi" ]; then
    sudo mkdir -p /home/pi
    sudo chown -R "$TARGET_USER:$TARGET_USER" /home/pi
    ln -sfn "$TARGET_HOME/.Xauthority" /home/pi/.Xauthority 2>/dev/null || true
fi

# 2. Preparar repositorios (incluye fix automático para Raspbian Buster EOL) e instalar paquetes
echo "[2/7] Instalando dependencias del sistema (ffmpeg, feh, curl, audio, reproductor, nodejs)..."
if [ "$OS_CODENAME" = "buster" ] && [ -f "/etc/apt/sources.list" ]; then
    sudo sed -i 's|http://raspbian.raspberrypi.org/raspbian|http://legacy.raspbian.org/raspbian|g' /etc/apt/sources.list 2>/dev/null || true
    if [ -f "/etc/apt/sources.list.d/raspi.list" ]; then
        sudo sed -i 's|http://archive.raspberrypi.org/debian|http://legacy.raspbian.org/debian|g' /etc/apt/sources.list.d/raspi.list 2>/dev/null || true
    fi
fi

sudo apt-get update --allow-releaseinfo-change -y || sudo apt-get update -y
sudo apt-get install -y curl ffmpeg feh unclutter x11-xserver-utils alsa-utils
sudo apt-get install -y wlr-randr raspi2png 2>/dev/null || true

# Instalar reproductor según generación de Raspberry Pi y disponibilidad en repositorios (Trixie/Bookworm usan mpv)
if apt-cache show omxplayer >/dev/null 2>&1 && ! echo "$PI_MODEL" | grep -qiE "Pi 4|Pi 5|Pi 400|Compute Module 4"; then
    sudo apt-get install -y omxplayer || sudo apt-get install -y mpv
else
    sudo apt-get install -y mpv
fi

# Instalar Node.js y npm si no están presentes
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    sudo apt-get install -y nodejs npm
fi

# Instalar PM2 globalmente si falta
if ! command -v pm2 >/dev/null 2>&1; then
    echo "  -> Instalando PM2..."
    sudo npm install -g pm2
fi

# 3. Crear estructura de carpetas y package.json
echo "[3/7] Creando directorios e instalando módulos Node.js en /home/pi/URP..."
mkdir -p /home/pi/URP/content /home/pi/URP/temp /home/pi/URP/seamless /home/pi/URP/optimized /home/pi/URP/web
cd /home/pi/URP

cat << 'EOF' > /home/pi/URP/package.json
{
  "name": "urp-signage-client",
  "version": "2.5.7",
  "description": "Digital Signage Client for Raspberry Pi 3B+/4/5",
  "main": "URPPI3-v2.5.js",
  "scripts": {
    "start": "node URPPI3-v2.5.js"
  },
  "dependencies": {
    "async": "^3.2.5",
    "express": "^4.21.2",
    "jsftp": "^2.1.3",
    "lodash": "^4.17.21"
  }
}
EOF

npm install --production --no-audit --no-fund
npm install level --no-audit --no-fund 2>/dev/null || true

# 4. Descargar y validar sintaxis del cliente URP desde GitHub (público o privado) o servidor configurado
echo "[4/7] Descargando $URP_SCRIPT_FILE desde $URP_SOURCE_URL..."
CURL_AUTH_ARGS=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
    CURL_AUTH_ARGS=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    echo "  -> Token GitHub detectado: usando autenticación para repositorio privado."
fi

CACHE_BUST=""
case "$URP_SOURCE_URL" in *"?"*) ;; *) CACHE_BUST="?t=$(date +%s)" ;; esac

INSTALLED_SCRIPT_PATH="/home/pi/URP/${URP_SCRIPT_FILE}"
TMP_URP_JS="/home/pi/URP/.URPPI3.tmp.js"
rm -f "$TMP_URP_JS"
if ! curl -fsSL "${CURL_AUTH_ARGS[@]}" -H "Cache-Control: no-cache" "${URP_SOURCE_URL}${CACHE_BUST}" -o "$TMP_URP_JS"; then
    if [ -n "${GITHUB_REPO:-}" ] && [ "$URP_SCRIPT_FILE" = "URPPI3-v2.5.js" ]; then
        FALLBACK_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/URPPI3.js"
        echo "  -> URPPI3-v2.5.js no encontrado aún; probando URPPI3.js: $FALLBACK_URL"
        if curl -fsSL "${CURL_AUTH_ARGS[@]}" -H "Cache-Control: no-cache" "${FALLBACK_URL}${CACHE_BUST}" -o "$TMP_URP_JS"; then
            INSTALLED_SCRIPT_PATH="/home/pi/URP/URPPI3.js"
        fi
    fi
fi
if [ ! -s "$TMP_URP_JS" ] && [ -n "${GITHUB_REPO:-}" ] && [ "$GITHUB_BRANCH" = "main" ]; then
    URP_SOURCE_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/master/${URP_SCRIPT_FILE}"
    echo "  -> Probando rama master: $URP_SOURCE_URL"
    curl -fsSL "${CURL_AUTH_ARGS[@]}" -H "Cache-Control: no-cache" "${URP_SOURCE_URL}${CACHE_BUST}" -o "$TMP_URP_JS" || true
fi
if [ ! -s "$TMP_URP_JS" ]; then
    echo "ERROR: No se pudo descargar $URP_SCRIPT_FILE desde $URP_SOURCE_URL"
    if [ -z "${GITHUB_TOKEN:-}" ]; then
        echo "  Si el repositorio es privado, exporta primero: export GITHUB_TOKEN="tu_token""
    fi
    rm -f "$TMP_URP_JS"
    exit 1
fi
node --check "$TMP_URP_JS"
mv -f "$TMP_URP_JS" "$INSTALLED_SCRIPT_PATH"
chmod +x "$INSTALLED_SCRIPT_PATH"

# Descargar configurador independiente de Video Wall (ejecutable: urp-wall)
if [ -n "${GITHUB_REPO:-}" ]; then
    WALL_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/urp-wall.sh"
    TMP_WALL_SH="/home/pi/URP/.urp-wall.tmp.sh"
    rm -f "$TMP_WALL_SH"
    if curl -fsSL "${CURL_AUTH_ARGS[@]}" -H "Cache-Control: no-cache" "${WALL_URL}${CACHE_BUST}" -o "$TMP_WALL_SH" 2>/dev/null; then
        if bash -n "$TMP_WALL_SH" 2>/dev/null; then
            mv -f "$TMP_WALL_SH" /home/pi/URP/urp-wall.sh
            chmod +x /home/pi/URP/urp-wall.sh
            sudo ln -sf /home/pi/URP/urp-wall.sh /usr/local/bin/urp-wall 2>/dev/null || true
            echo "  -> Ejecutable Video Wall instalado: escribe 'urp-wall' para configurarlo."
        else
            rm -f "$TMP_WALL_SH"
        fi
    fi
fi

# 5. Configurar GPU, X11, Desktop Autologin y neutralizar fondo/salvapantallas
echo "[5/7] Configurando GPU, Autologin gráfico, X11 y pantalla negra..."
if command -v raspi-config >/dev/null 2>&1; then
    # Autologin al escritorio gráfico (B4)
    sudo raspi-config nonint do_boot_behaviour B4 2>/dev/null || true
    # Si es Bookworm/Wayland, cambiar a X11 (W1) para compatibilidad total con feh/DISPLAY=:0
    sudo raspi-config nonint do_wayland W1 2>/dev/null || true
    # Solo en sistemas legacy con omxplayer (Buster/Bullseye) fijar gpu_mem=128; en Trixie/Bookworm KMS usa CMA dinámico
    if command -v omxplayer >/dev/null 2>&1 && ! echo "$PI_MODEL" | grep -qiE "Pi 4|Pi 5|Pi 400"; then
        sudo raspi-config nonint do_memory_split 128 2>/dev/null || true
    fi
fi

# Neutralizar fondo, paneles y popups de montaje en todas las variantes (LXDE-pi, LXDE-pi-x, rpd-x, default)
for PCDIR in "$TARGET_HOME/.config/pcmanfm/LXDE-pi" "$TARGET_HOME/.config/pcmanfm/LXDE-pi-x" "$TARGET_HOME/.config/pcmanfm/rpd-x" "$TARGET_HOME/.config/pcmanfm/default"; do
    mkdir -p "$PCDIR"
    cat << 'EOF' > "$PCDIR/desktop-items-0.conf"
[*]
wallpaper_mode=color
wallpaper=
desktop_bg=#000000
desktop_fg=#000000
desktop_shadow=#000000
show_documents=0
show_trash=0
show_mounts=0
EOF
    cat << 'EOF' > "$PCDIR/pcmanfm.conf"
[config]
bm_open_method=0

[volume]
mount_on_startup=0
mount_removable=0
autorun=0
EOF
done

# Bloquear permanentemente popups y el gestor de escritorio pcmanfm ('Drawing desktop')
mkdir -p "$TARGET_HOME/.config/autostart"
for DESK in pcmanfm.desktop rpd-wallpaper.desktop piwiz.desktop xfce4-notifyd.desktop notification-daemon.desktop lxqt-notificationd.desktop blueman.desktop nm-applet.desktop update-notifier.desktop package-update-indicator.desktop pk-update-icon.desktop lxpolkit.desktop polkit-gnome-authentication-agent-1.desktop xscreensaver.desktop org.gnome.SettingsDaemon.DiskUtilityNotify.desktop user-dirs-update-gtk.desktop; do
    cat << 'EOF' > "$TARGET_HOME/.config/autostart/$DESK"
[Desktop Entry]
Hidden=true
EOF
done
systemctl --user mask xfce4-notifyd.service mako.service dunst.service 2>/dev/null || true

# Configurar autostart sin pcmanfm, sin panel y sin salvapantallas (LXDE-pi, LXDE-pi-x, rpd-x, Openbox)
for AS_DIR in "$TARGET_HOME/.config/lxsession/LXDE-pi" "$TARGET_HOME/.config/lxsession/LXDE-pi-x" "$TARGET_HOME/.config/lxsession/rpd-x" "$TARGET_HOME/.config/openbox"; do
    mkdir -p "$AS_DIR"
    AS_FILE="$AS_DIR/autostart"
    touch "$AS_FILE"
    sed -i '/lxpanel/d;/wf-panel-pi/d;/pcmanfm/d;/rpd-wallpaper/d' "$AS_FILE" 2>/dev/null || true
    grep -q "#URP_CLEAN" "$AS_FILE" || sed -i '1i #URP_CLEAN' "$AS_FILE" 2>/dev/null || true
    grep -q "xset s off" "$AS_FILE" || echo "@xset s off" >> "$AS_FILE"
    grep -q "xset -dpms" "$AS_FILE" || echo "@xset -dpms" >> "$AS_FILE"
    grep -q "xset s noblank" "$AS_FILE" || echo "@xset s noblank" >> "$AS_FILE"
    grep -q "xhost +local:" "$AS_FILE" || echo "@xhost +local:" >> "$AS_FILE"
    if ! grep -q "xrandr --output" "$AS_FILE"; then
        printf "# Rotacion vertical URP (opcional si usas X11 manual: descomentar right=90deg o left=270deg)
#@xrandr --output HDMI-1 --rotate right
" >> "$AS_FILE"
    fi
done

# Limpiar también autostart globales de pcmanfm/lwrespawn para evitar el cartel 'Drawing desktop'
for SYS_AS in /etc/xdg/lxsession/*/autostart; do
    if [ -f "$SYS_AS" ]; then
        sudo sed -i '/pcmanfm --desktop/d;/lxpanel/d;/wf-panel-pi/d' "$SYS_AS" 2>/dev/null || true
    fi
done
if [ -f /etc/xdg/labwc/autostart ]; then
    sudo sed -i '/pcmanfm/d;/wf-panel-pi/d' /etc/xdg/labwc/autostart 2>/dev/null || true
fi

# Configurar labwc (por si Wayland sigue activo) sin lwrespawn/panel/notificaciones
mkdir -p "$TARGET_HOME/.config/labwc"
LABWC_AS="$TARGET_HOME/.config/labwc/autostart"
touch "$LABWC_AS"
grep -q "#URP_CLEAN" "$LABWC_AS" || echo "#URP_CLEAN" >> "$LABWC_AS"
grep -q "lwrespawn" "$LABWC_AS" || echo "pkill -9 -f 'lwrespawn.*(pcmanfm|wf-panel)' 2>/dev/null || true" >> "$LABWC_AS"
grep -q "pkill -9 mako" "$LABWC_AS" || echo "pkill -9 mako wf-panel-pi 2>/dev/null || true" >> "$LABWC_AS"
if ! grep -q "wlr-randr" "$LABWC_AS"; then
    printf "# Rotacion vertical Wayland: descomentar 90 o 270
#wlr-randr --output HDMI-A-1 --transform 90 &
" >> "$LABWC_AS"
fi

AUTOSTART="$TARGET_HOME/.config/lxsession/LXDE-pi/autostart"
chown -R "$TARGET_USER:$TARGET_USER" "$TARGET_HOME/.config"

# Dejar opción de rotación comentada y ocultar avisos OSD de firmware en config.txt
CFG_FILE="/boot/config.txt"
[ -f "/boot/firmware/config.txt" ] && CFG_FILE="/boot/firmware/config.txt"
if [ -f "$CFG_FILE" ]; then
    if ! grep -qE "^avoid_warnings=" "$CFG_FILE"; then
        echo "avoid_warnings=1" | sudo tee -a "$CFG_FILE" >/dev/null
    fi
    if ! grep -qE "^#?s*display_hdmi_rotate=" "$CFG_FILE"; then
        printf "
# Rotacion vertical URP (descomentar 1=90deg o 3=270deg; URPPI3.js la aplica en Buster, Bookworm y Trixie)
#display_hdmi_rotate=1
" | sudo tee -a "$CFG_FILE" >/dev/null
    fi
fi

# 6. Permitir reinicio, apagado, hostname, tailscale y display_power sin contraseña sudo
echo "[6/7] Configurando permisos NOPASSWD y protección anti-desgaste de microSD..."
cat << EOF | sudo tee /etc/sudoers.d/urp >/dev/null
$TARGET_USER ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown, /sbin/poweroff, /usr/sbin/reboot, /usr/sbin/shutdown, /usr/sbin/poweroff, /bin/systemctl reboot, /bin/systemctl poweroff, /usr/bin/hostnamectl, /bin/hostnamectl, /usr/bin/tailscale, /usr/bin/vcgencmd
EOF
sudo chmod 0440 /etc/sudoers.d/urp

# Protección de tarjeta microSD: journald en RAM (volatile) con tope de 32MB
sudo mkdir -p /etc/systemd/journald.conf.d
cat << 'EOF' | sudo tee /etc/systemd/journald.conf.d/urp-volatile.conf >/dev/null
[Journal]
Storage=volatile
RuntimeMaxUse=32M
EOF
sudo systemctl restart systemd-journald 2>/dev/null || true

# 7. Iniciar con PM2, rotación de logs y arranque automático al encender
echo "[7/7] Registrando servicio en PM2 y configurando pm2-logrotate..."
NODE_BIN_DIR="$(dirname "$(command -v node)")"
sudo env PATH="$PATH:$NODE_BIN_DIR" pm2 startup systemd -u "$TARGET_USER" --hp "$TARGET_HOME" >/dev/null 2>&1 || true

# Rotación automática de logs en PM2 para proteger la microSD
pm2 install pm2-logrotate 2>/dev/null || true
pm2 set pm2-logrotate:max_size 10M 2>/dev/null || true
pm2 set pm2-logrotate:retain 3 2>/dev/null || true
pm2 set pm2-logrotate:compress true 2>/dev/null || true

cd /home/pi/URP
pm2 delete URP 2>/dev/null || true
DISPLAY=:0 XAUTHORITY=/home/pi/.Xauthority pm2 start "$INSTALLED_SCRIPT_PATH" --name URP
pm2 save

# 8. Tailscale integrado para acceso remoto y mantenimiento (:8090) sin Auth Key obligatoria
if [ "$URP_TAILSCALE" = "1" ]; then
    echo "[+] Configurando Tailscale integrado..."
    if ! command -v tailscale >/dev/null 2>&1; then
        curl -fsSL https://tailscale.com/install.sh | sudo sh || true
    fi
    if command -v tailscale >/dev/null 2>&1; then
        sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true
        CUR_TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
        if [ -z "$CUR_TS_IP" ] && [ -t 0 ]; then
            read -r -p "Tailscale instalado. ¿Querés vincularlo ahora mostrando el link de login? [s/N]: " LINK_TS_NOW || true
            if [ "${LINK_TS_NOW,,}" = "s" ] || [ "${LINK_TS_NOW,,}" = "si" ]; then
                sudo tailscale up --hostname="$(hostname)" --accept-dns=true || true
                CUR_TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
            fi
        fi
        if [ -n "$CUR_TS_IP" ]; then
            echo "  -> Tailscale ACTIVO! IP remota: $CUR_TS_IP (Panel: http://$CUR_TS_IP:8090)"
        else
            echo "  -> Tailscale instalado. Para vincularlo sin Auth Key ejecutá:"
            echo "     sudo tailscale up --hostname=$(hostname)"
        fi
    fi
fi

echo "=========================================================="
echo "  ¡INSTALACIÓN COMPLETADA CON ÉXITO! (v2.5.7)"
echo "  - Script activo: $INSTALLED_SCRIPT_PATH"
echo "  - Ver logs en vivo: pm2 logs URP"
echo "  - Configurar Video Wall (opcional): urp-wall"
echo "  - Panel web local / soporte en vivo: http://IP_DE_LA_PI:8090"
echo "  - Vinculación Tailscale sin token/key:"
echo "      curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --hostname=tv1hjumbo"
echo "  - Protección microSD activa: journald volátil (32MB) + pm2-logrotate (10MB x 3)."
echo "  - Notificaciones y popups del sistema desactivados."
echo "  - Para pantalla vertical: abrilo en http://IP_DE_LA_PI:8090 o 'urp-wall'"
echo "  - Reiniciá una vez para aplicar Autologin, X11 y rotación:"
echo "      sudo reboot"
echo "=========================================================="
