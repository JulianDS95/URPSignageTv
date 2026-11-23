#!/bin/bash
# ==============================================================================
# Instalador Automático Zero-Touch - URP Digital Signage v2.2.0
# Compatible con Raspberry Pi 3B+ (Buster/Legacy) y Raspberry Pi 4 / 5 (Bullseye/Bookworm)
# Uso desde GitHub público (sin tocar el servidor tbee.tv):
#   curl -fsSL https://raw.githubusercontent.com/USUARIO/REPO/main/install-urp.sh | bash -s -- USUARIO/REPO
# Uso desde GitHub PRIVADO (con Fine-Grained Token solo lectura "Contents: Read-only"):
#   export GITHUB_TOKEN="github_pat_TU_TOKEN"
#   curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/USUARIO/REPO/main/install-urp.sh | bash -s -- USUARIO/REPO
#   unset GITHUB_TOKEN
# O si definis DEFAULT_GITHUB_REPO="USUARIO/REPO" abajo:
#   curl -fsSL https://raw.githubusercontent.com/USUARIO/REPO/main/install-urp.sh | bash
# ==============================================================================
set -e

DEFAULT_GITHUB_REPO=""
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
ARG_SOURCE="${1:-}"

if [ -n "$ARG_SOURCE" ]; then
    case "$ARG_SOURCE" in
        http://*|https://*) URP_SOURCE_URL="$ARG_SOURCE" ;;
        */*) GITHUB_REPO="$ARG_SOURCE" ;;
    esac
fi

GITHUB_REPO="${GITHUB_REPO:-$DEFAULT_GITHUB_REPO}"
if [ -z "${URP_SOURCE_URL:-}" ] && [ -n "$GITHUB_REPO" ]; then
    URP_SOURCE_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/URPPI3.js"
fi
URP_SOURCE_URL="${URP_SOURCE_URL:-http://tbee.tv/URP/URPPI3.js}"

if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    TARGET_USER="$SUDO_USER"
    TARGET_HOME="$(eval echo ~"$SUDO_USER")"
else
    TARGET_USER="$(whoami)"
    TARGET_HOME="$HOME"
fi

echo "=========================================================="
echo "  Instalador Automático URP Digital Signage (v2.2.0)"
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
echo "[2/7] Instalando dependencias del sistema (ffmpeg, feh, curl, reproductor, nodejs)..."
if [ "$OS_CODENAME" = "buster" ] && [ -f "/etc/apt/sources.list" ]; then
    sudo sed -i 's|http://raspbian.raspberrypi.org/raspbian|http://legacy.raspbian.org/raspbian|g' /etc/apt/sources.list 2>/dev/null || true
    if [ -f "/etc/apt/sources.list.d/raspi.list" ]; then
        sudo sed -i 's|http://archive.raspberrypi.org/debian|http://legacy.raspberrypi.org/debian|g' /etc/apt/sources.list.d/raspi.list 2>/dev/null || true
    fi
fi

sudo apt-get update --allow-releaseinfo-change -y || sudo apt-get update -y
sudo apt-get install -y curl ffmpeg feh unclutter x11-xserver-utils

# Instalar reproductor según generación de Raspberry Pi
if echo "$PI_MODEL" | grep -qiE "Pi 4|Pi 5|Pi 400|Compute Module 4"; then
    sudo apt-get install -y mpv
else
    sudo apt-get install -y omxplayer || sudo apt-get install -y mpv
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
mkdir -p /home/pi/URP/content /home/pi/URP/temp /home/pi/URP/seamless /home/pi/URP/web
cd /home/pi/URP

cat << 'EOF' > /home/pi/URP/package.json
{
  "name": "urp-signage-client",
  "version": "2.2.0",
  "description": "Digital Signage Client for Raspberry Pi 3B+/4/5",
  "main": "URPPI3.js",
  "scripts": {
    "start": "node URPPI3.js"
  },
  "dependencies": {
    "async": "^3.2.5",
    "express": "^4.21.2",
    "jsftp": "^2.1.3",
    "lodash": "^4.17.21",
    "request": "^2.88.2"
  }
}
EOF

npm install --production --no-audit --no-fund
npm install level --no-audit --no-fund 2>/dev/null || true

# 4. Descargar y validar sintaxis de URPPI3.js desde GitHub (público o privado) o servidor configurado
echo "[4/7] Descargando URPPI3.js desde $URP_SOURCE_URL..."
CURL_AUTH_ARGS=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
    CURL_AUTH_ARGS=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    echo "  -> Token GitHub detectado: usando autenticación para repositorio privado."
fi

if ! curl -fsSL "${CURL_AUTH_ARGS[@]}" -H "Cache-Control: no-cache" "$URP_SOURCE_URL" -o /home/pi/URP/URPPI3.js.tmp; then
    if [ -n "${GITHUB_REPO:-}" ] && [ "$GITHUB_BRANCH" = "main" ]; then
        URP_SOURCE_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/master/URPPI3.js"
        echo "  -> Probando rama master: $URP_SOURCE_URL"
        curl -fsSL "${CURL_AUTH_ARGS[@]}" -H "Cache-Control: no-cache" "$URP_SOURCE_URL" -o /home/pi/URP/URPPI3.js.tmp
    else
        echo "ERROR: No se pudo descargar URPPI3.js desde $URP_SOURCE_URL"
        if [ -z "${GITHUB_TOKEN:-}" ]; then
            echo "  Si el repositorio es privado, exporta primero: export GITHUB_TOKEN="tu_token""
        fi
        exit 1
    fi
fi
node --check /home/pi/URP/URPPI3.js.tmp
mv -f /home/pi/URP/URPPI3.js.tmp /home/pi/URP/URPPI3.js
chmod +x /home/pi/URP/URPPI3.js

# 5. Configurar GPU, X11, Desktop Autologin y neutralizar fondo/salvapantallas
echo "[5/7] Configurando GPU, Autologin gráfico, X11 y pantalla negra..."
if command -v raspi-config >/dev/null 2>&1; then
    # Autologin al escritorio gráfico (B4)
    sudo raspi-config nonint do_boot_behaviour B4 2>/dev/null || true
    # Si es Bookworm/Wayland, cambiar a X11 (W1) para compatibilidad total con feh/DISPLAY=:0
    sudo raspi-config nonint do_wayland W1 2>/dev/null || true
    # En Raspberry Pi 3B+ fijar 128MB de GPU para VideoCore IV
    if ! echo "$PI_MODEL" | grep -qiE "Pi 4|Pi 5|Pi 400"; then
        sudo raspi-config nonint do_memory_split 128 2>/dev/null || true
    fi
fi

mkdir -p "$TARGET_HOME/.config/pcmanfm/LXDE-pi" "$TARGET_HOME/.config/lxsession/LXDE-pi"
cat << 'EOF' > "$TARGET_HOME/.config/pcmanfm/LXDE-pi/desktop-items-0.conf"
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

AUTOSTART="$TARGET_HOME/.config/lxsession/LXDE-pi/autostart"
touch "$AUTOSTART"
grep -q "xset s off" "$AUTOSTART" || echo "@xset s off" >> "$AUTOSTART"
grep -q "xset -dpms" "$AUTOSTART" || echo "@xset -dpms" >> "$AUTOSTART"
grep -q "xset s noblank" "$AUTOSTART" || echo "@xset s noblank" >> "$AUTOSTART"
chown -R "$TARGET_USER:$TARGET_USER" "$TARGET_HOME/.config"

# 6. Permitir reinicio y apagado remoto desde el Manager sin contraseña sudo
echo "[6/7] Configurando permisos NOPASSWD para reinicio y apagado remoto..."
cat << EOF | sudo tee /etc/sudoers.d/urp >/dev/null
$TARGET_USER ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown, /sbin/poweroff, /usr/sbin/reboot, /usr/sbin/shutdown, /usr/sbin/poweroff, /bin/systemctl reboot, /bin/systemctl poweroff
EOF
sudo chmod 0440 /etc/sudoers.d/urp

# 7. Iniciar con PM2 y registrar arranque automático al encender
echo "[7/7] Registrando servicio en PM2..."
NODE_BIN_DIR="$(dirname "$(command -v node)")"
sudo env PATH="$PATH:$NODE_BIN_DIR" pm2 startup systemd -u "$TARGET_USER" --hp "$TARGET_HOME" >/dev/null 2>&1 || true

cd /home/pi/URP
pm2 delete URP 2>/dev/null || true
DISPLAY=:0 XAUTHORITY=/home/pi/.Xauthority pm2 start /home/pi/URP/URPPI3.js --name URP
pm2 save

echo "=========================================================="
echo "  ¡INSTALACIÓN COMPLETADA CON ÉXITO!"
echo "  - Ver logs en vivo: pm2 logs URP"
echo "  - Reiniciá una vez para aplicar Autologin, X11 y GPU:"
echo "      sudo reboot"
echo "=========================================================="
