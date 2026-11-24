#!/usr/bin/env bash
# ==============================================================================
# URP Video Wall Configurator (urp-wall.sh)
# Ejecutable independiente para activar y configurar Video Wall en Raspberry Pi.
# - Modo Normal (wall.json inexistente o enabled=false): URPPI3 funciona normal.
# - Modo Video Wall (enabled=true): recorte automático en mosaico (tile) o espejo
#   (mirror), ID de pantalla (1..N), disposición (filas x cols), bisel, orientación
#   y sincronización sin Master (NTP) o por IP de Master local.
# Uso: urp-wall   (o bash /home/pi/URP/urp-wall.sh [--status | --off])
# ==============================================================================
set -u

if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js no está instalado en esta Raspberry Pi."
    exit 1
fi

IFS= read -r -d '' NODE_SCRIPT << 'URP_WALL_NODE_EOF' || true
var fs = require('fs');
var path = require('path');
var readline = require('readline');
var execSync = require('child_process').execSync;

var URP_DIR = '/home/pi/URP';
var WALL_JSON = path.join(URP_DIR, 'wall.json');
var CONTENT_DIR = path.join(URP_DIR, 'content');
var OPT_DIR = path.join(URP_DIR, 'optimized');
var SEAMLESS_DIR = path.join(URP_DIR, 'seamless');

function getConfigTxtPath() {
    if (fs.existsSync('/boot/firmware/config.txt')) return '/boot/firmware/config.txt';
    if (fs.existsSync('/boot/config.txt')) return '/boot/config.txt';
    return '';
}

function readHdmiRotate() {
    var cfg = getConfigTxtPath();
    if (!cfg) return 0;
    try {
        var lines = fs.readFileSync(cfg, 'utf8').split(/\r?\n/);
        var found = 0;
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim();
            if (!ln || ln.charAt(0) === '#') continue;
            var m = ln.match(/^display_hdmi_rotate\s*=\s*([0-3])/i);
            if (m) found = parseInt(m[1], 10);
        }
        return found;
    } catch (e) {
        return 0;
    }
}

function writeHdmiRotate(rot) {
    var cfg = getConfigTxtPath();
    if (!cfg) return { ok: false, reason: 'config.txt no encontrado' };
    var val = parseInt(rot, 10);
    if (isNaN(val) || val < 0 || val > 3) val = 0;
    try {
        var raw = fs.readFileSync(cfg, 'utf8');
        var lines = raw.split(/\r?\n/);
        var replaced = false;
        var outLines = [];
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (/^\s*#?\s*display_hdmi_rotate\s*=/.test(ln)) {
                if (!replaced) {
                    outLines.push(val === 0 ? '#display_hdmi_rotate=1' : ('display_hdmi_rotate=' + val));
                    replaced = true;
                }
            } else {
                outLines.push(ln);
            }
        }
        if (!replaced && val > 0) {
            outLines.push('');
            outLines.push('# Rotacion URP (' + val + ')');
            outLines.push('display_hdmi_rotate=' + val);
        }
        var tmpFile = '/tmp/urp_config_' + Date.now() + '.txt';
        fs.writeFileSync(tmpFile, outLines.join('\n'), 'utf8');
        execSync('sudo cp "' + tmpFile + '" "' + cfg + '" && rm -f "' + tmpFile + '"', { stdio: 'inherit' });
        return { ok: true, path: cfg };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

function orientationLabel(rot) {
    if (rot === 1) return '90° Vertical (Derecha - display_hdmi_rotate=1)';
    if (rot === 2) return '180° Invertido (display_hdmi_rotate=2)';
    if (rot === 3) return '270° Vertical (Izquierda - display_hdmi_rotate=3)';
    return '0° Horizontal Normal';
}

function loadConfig() {
    var curRot = readHdmiRotate();
    var def = {
        enabled: true,
        activationMode: 'server',
        mode: 'tile',
        screenId: 1,
        rows: 1,
        cols: 3,
        row: 0,
        col: 0,
        bezelPx: 0,
        orientation: curRot,
        syncMode: 'ntp',
        masterIp: '',
        updatedAt: ''
    };
    try {
        if (!fs.existsSync(WALL_JSON)) return def;
        var raw = JSON.parse(fs.readFileSync(WALL_JSON, 'utf8'));
        var rows = Math.max(1, parseInt(raw.rows, 10) || 1);
        var cols = Math.max(1, parseInt(raw.cols, 10) || 3);
        var total = rows * cols;
        var screenId = Math.min(total, Math.max(1, parseInt(raw.screenId, 10) || 1));
        var actMode = (raw.activationMode === 'server' || raw.activationMode === 'local') ? raw.activationMode : 'local';
        return {
            enabled: Boolean(raw.enabled),
            activationMode: actMode,
            mode: (raw.mode === 'mirror') ? 'mirror' : 'tile',
            screenId: screenId,
            rows: rows,
            cols: cols,
            row: Math.floor((screenId - 1) / cols),
            col: (screenId - 1) % cols,
            bezelPx: Math.max(0, Math.min(400, parseInt(raw.bezelPx, 10) || 0)),
            orientation: (typeof raw.orientation === 'number') ? raw.orientation : curRot,
            syncMode: (raw.syncMode === 'master') ? 'master' : 'ntp',
            masterIp: String(raw.masterIp || '').trim(),
            updatedAt: raw.updatedAt || ''
        };
    } catch (e) {
        return def;
    }
}

function normalizeComputedFields(cfg) {
    cfg.rows = Math.max(1, parseInt(cfg.rows, 10) || 1);
    cfg.cols = Math.max(1, parseInt(cfg.cols, 10) || 1);
    var total = cfg.rows * cfg.cols;
    cfg.screenId = Math.min(total, Math.max(1, parseInt(cfg.screenId, 10) || 1));
    cfg.row = Math.floor((cfg.screenId - 1) / cfg.cols);
    cfg.col = (cfg.screenId - 1) % cfg.cols;
    cfg.bezelPx = Math.max(0, Math.min(400, parseInt(cfg.bezelPx, 10) || 0));
    cfg.orientation = [0, 1, 2, 3].indexOf(cfg.orientation) !== -1 ? cfg.orientation : 0;
    return cfg;
}

function saveWallJson(cfg) {
    normalizeComputedFields(cfg);
    cfg.updatedAt = new Date().toISOString();
    if (!fs.existsSync(URP_DIR)) fs.mkdirSync(URP_DIR, { recursive: true });
    var tmp = WALL_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, WALL_JSON);
    var targetUser = process.env.SUDO_USER || '';
    if (targetUser && targetUser !== 'root') {
        try { execSync('chown "' + targetUser + ':' + targetUser + '" "' + WALL_JSON + '"', { stdio: 'ignore' }); } catch (e) {}
    }
}

function clearWallCaches() {
    var dirs = [OPT_DIR, SEAMLESS_DIR];
    for (var d = 0; d < dirs.length; d++) {
        try {
            if (!fs.existsSync(dirs[d])) continue;
            var files = fs.readdirSync(dirs[d]);
            for (var i = 0; i < files.length; i++) {
                try { fs.unlinkSync(path.join(dirs[d], files[i])); } catch (e) {}
            }
        } catch (e) {}
    }
    try {
        if (fs.existsSync(CONTENT_DIR)) {
            var cfiles = fs.readdirSync(CONTENT_DIR);
            for (var j = 0; j < cfiles.length; j++) {
                if (/_W[TM][^_]*_.*_\d+s\.mp4$/i.test(cfiles[j]) || /_WM_\d+s\.mp4$/i.test(cfiles[j])) {
                    try { fs.unlinkSync(path.join(CONTENT_DIR, cfiles[j])); } catch (e) {}
                }
            }
        }
    } catch (e) {}
}

function restartUrpService() {
    var targetUser = process.env.SUDO_USER || '';
    try {
        if (process.getuid && process.getuid() === 0 && targetUser && targetUser !== 'root') {
            execSync('sudo -u "' + targetUser + '" pm2 restart URP 2>/dev/null || pm2 restart URP 2>/dev/null || true', { stdio: 'inherit' });
        } else {
            execSync('pm2 restart URP 2>/dev/null || sudo systemctl restart urp 2>/dev/null || true', { stdio: 'inherit' });
        }
    } catch (e) {}
}

function renderGridAscii(cfg) {
    var lines = [];
    var id = 1;
    for (var r = 0; r < cfg.rows; r++) {
        var top = '  ';
        var mid = '  ';
        var sub = '  ';
        var bot = '  ';
        for (var c = 0; c < cfg.cols; c++) {
            var isMe = (id === cfg.screenId);
            var tag = isMe ? ('[>' + id + '<]') : (' [' + id + '] ');
            while (tag.length < 7) tag = ' ' + tag;
            if (tag.length > 7) tag = tag.slice(0, 7);
            var coord = ' f' + (r + 1) + ',c' + (c + 1) + ' ';
            while (coord.length < 7) coord += ' ';
            top += '+-------+ ';
            mid += '|' + tag + '| ';
            sub += '|' + coord.slice(0, 7) + '| ';
            bot += '+-------+ ';
            id++;
        }
        lines.push(top, mid, sub, bot);
    }
    return lines.join('\n');
}

function activationLabel(cfg) {
    if (cfg.activationMode === 'server') {
        return 'REMOTO desde tbee.tv (se activa/desactiva desde el panel web)';
    }
    return cfg.enabled
        ? 'SIEMPRE ACTIVO (Local en esta Pi)'
        : 'DESACTIVADO (Modo Normal URPPI3)';
}

function printSummary(cfg) {
    normalizeComputedFields(cfg);
    console.log('\n==============================================================');
    console.log('       URP DIGITAL SIGNAGE - CONFIGURADOR VIDEO WALL          ');
    console.log('==============================================================');
    console.log('  Activación VW     : ' + activationLabel(cfg));
    console.log('  Modo de Reprod.   : ' + (cfg.mode === 'tile' ? 'Mosaico / Imagen Partida (tile)' : 'Espejo Sincronizado (mirror)'));
    console.log('  Disposición       : ' + cfg.rows + ' fila(s) x ' + cfg.cols + ' columna(s) (' + (cfg.rows * cfg.cols) + ' pantallas)');
    console.log('  ID de esta Pi     : Pantalla #' + cfg.screenId + ' (Fila ' + (cfg.row + 1) + ', Columna ' + (cfg.col + 1) + ')');
    console.log('  Bisel (marco px)  : ' + cfg.bezelPx + ' px');
    console.log('  Orientación       : ' + orientationLabel(cfg.orientation));
    var syncTxt = (cfg.syncMode === 'ntp')
        ? 'NTP automático (sin equipo Master)'
        : (cfg.masterIp ? ('Slave LAN -> Master ' + cfg.masterIp + ':8090') : 'Master LAN (escuchando en :8090)');
    console.log('  Sincronización    : ' + syncTxt);
    console.log('--------------------------------------------------------------');
    console.log('  Mapa de Matriz (Pantalla actual marcada con >ID<):');
    console.log(renderGridAscii(cfg));
    console.log('==============================================================');
}

var args = process.argv.slice(1);
if (args.indexOf('--status') !== -1) {
    printSummary(loadConfig());
    process.exit(0);
}
if (args.indexOf('--off') !== -1) {
    var offCfg = loadConfig();
    offCfg.activationMode = 'local';
    offCfg.enabled = false;
    saveWallJson(offCfg);
    clearWallCaches();
    restartUrpService();
    console.log('Video Wall DESACTIVADO. URPPI3 restaurado a modo normal.');
    process.exit(0);
}
if (args.indexOf('--remote') !== -1) {
    var remCfg = loadConfig();
    remCfg.activationMode = 'server';
    remCfg.enabled = true;
    saveWallJson(remCfg);
    clearWallCaches();
    restartUrpService();
    console.log('Video Wall configurado en modo REMOTO (controlado por tbee.tv).');
    process.exit(0);
}

var cfg = loadConfig();
var initialConfigTxtRot = readHdmiRotate();
var dirty = false;

var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(q, cb) {
    rl.question(q, function (ans) {
        cb(String(ans || '').trim());
    });
}

function showMainMenu() {
    printSummary(cfg);
    console.log('  1) Modo de activación (Remoto desde tbee.tv / Local / Desactivado)');
    console.log('  2) Disposición y Modo (1x2, 1x3, 2x2, etc. / Mosaico vs Espejo)');
    console.log('  3) Elegir ID de esta Pantalla (1..' + (cfg.rows * cfg.cols) + ')');
    console.log('  4) Orientación de Pantalla (Horizontal / Vertical 90° / 270°)');
    console.log('  5) Compensación de Bisel / Marco en px (actual: ' + cfg.bezelPx + ' px)');
    console.log('  6) Sincronización (NTP sin Master / Master-Slave LAN)');
    console.log('  7) GUARDAR, limpiar caché y reiniciar URPPI3' + (dirty ? ' [*]' : ''));
    console.log('  0) Salir sin guardar');
    console.log('');
    ask('Seleccioná una opción [0-7]: ', function (opt) {
        if (opt === '1') return menuActivation();
        if (opt === '2') return menuLayout();
        if (opt === '3') return menuScreenId();
        if (opt === '4') return menuOrientation();
        if (opt === '5') return menuBezel();
        if (opt === '6') return menuSync();
        if (opt === '7') return saveAndExit();
        if (opt === '0') {
            rl.close();
            process.exit(0);
        }
        showMainMenu();
    });
}

function menuActivation() {
    console.log('\n--- MODO DE ACTIVACIÓN DE VIDEO WALL ---');
    console.log('  1) Controlado por servidor tbee.tv (Remoto: respeta el check Video Wall de tbee.tv)');
    console.log('  2) Siempre ACTIVO en esta Pi (Local: ignora el check del servidor)');
    console.log('  3) DESACTIVADO (Modo Normal URPPI3)');
    ask('Elegí activación [1-3]: ', function (ans) {
        if (ans === '1') { cfg.activationMode = 'server'; cfg.enabled = true; dirty = true; }
        if (ans === '2') { cfg.activationMode = 'local'; cfg.enabled = true; dirty = true; }
        if (ans === '3') { cfg.activationMode = 'local'; cfg.enabled = false; dirty = true; }
        showMainMenu();
    });
}

function menuLayout() {
    console.log('\n--- DISPOSICIÓN DE PANTALLAS ---');
    console.log('  1) 1 x 2 Horizontal (2 pantallas lado a lado)');
    console.log('  2) 1 x 3 Horizontal (3 pantallas lado a lado)');
    console.log('  3) 1 x 4 Horizontal (4 pantallas en fila)');
    console.log('  4) 2 x 1 Vertical apilado (2 pantallas)');
    console.log('  5) 3 x 1 Vertical apilado (3 pantallas)');
    console.log('  6) 2 x 2 Matriz (4 pantallas)');
    console.log('  7) 3 x 3 Matriz (9 pantallas)');
    console.log('  8) Personalizada (ingresar Filas x Columnas)');
    ask('Elegí disposición [Enter = mantener ' + cfg.rows + 'x' + cfg.cols + ']: ', function (ans) {
        var presets = {
            '1': [1, 2], '2': [1, 3], '3': [1, 4],
            '4': [2, 1], '5': [3, 1], '6': [2, 2], '7': [3, 3]
        };
        if (presets[ans]) {
            cfg.rows = presets[ans][0];
            cfg.cols = presets[ans][1];
            dirty = true;
            return askWallMode();
        }
        if (ans === '8') {
            return ask('Cantidad de FILAS (ej. 1, 2, 3): ', function (rAns) {
                var r = parseInt(rAns, 10);
                if (!isNaN(r) && r >= 1 && r <= 8) cfg.rows = r;
                ask('Cantidad de COLUMNAS (ej. 2, 3, 4): ', function (cAns) {
                    var c = parseInt(cAns, 10);
                    if (!isNaN(c) && c >= 1 && c <= 8) cfg.cols = c;
                    dirty = true;
                    askWallMode();
                });
            });
        }
        askWallMode();
    });
}

function askWallMode() {
    console.log('\n--- TIPO DE PROYECCIÓN ---');
    console.log('  1) Mosaico / Imagen partida (tile): cada pantalla muestra su parte del video');
    console.log('  2) Espejo sincronizado (mirror): todas muestran el video completo sincronizado');
    ask('Elegí modo [1-2, Enter = mantener ' + cfg.mode + ']: ', function (ans) {
        if (ans === '1') { cfg.mode = 'tile'; cfg.enabled = true; dirty = true; }
        if (ans === '2') { cfg.mode = 'mirror'; cfg.enabled = true; dirty = true; }
        normalizeComputedFields(cfg);
        showMainMenu();
    });
}

function menuScreenId() {
    normalizeComputedFields(cfg);
    var total = cfg.rows * cfg.cols;
    console.log('\n--- ID DE ESTA PANTALLA ---');
    console.log(renderGridAscii(cfg));
    ask('Ingresá el ID de esta Raspberry Pi (1 a ' + total + '): ', function (ans) {
        var id = parseInt(ans, 10);
        if (!isNaN(id) && id >= 1 && id <= total) {
            cfg.screenId = id;
            cfg.enabled = true;
            dirty = true;
            normalizeComputedFields(cfg);
        } else if (ans !== '') {
            console.log('Valor inválido. Debe estar entre 1 y ' + total + '.');
        }
        showMainMenu();
    });
}

function menuOrientation() {
    console.log('\n--- ORIENTACIÓN DE ESTA PANTALLA ---');
    console.log('  0) 0° Horizontal Normal');
    console.log('  1) 90° Vertical Derecha (display_hdmi_rotate=1)');
    console.log('  3) 270° Vertical Izquierda (display_hdmi_rotate=3)');
    console.log('  2) 180° Invertido (display_hdmi_rotate=2)');
    ask('Elegí orientación [0, 1, 2, 3]: ', function (ans) {
        if (ans === '0' || ans === '1' || ans === '2' || ans === '3') {
            cfg.orientation = parseInt(ans, 10);
            dirty = true;
        }
        showMainMenu();
    });
}

function menuBezel() {
    console.log('\n--- COMPENSACIÓN DE BISEL / MARCO ---');
    console.log('  0 = Sin recorte entre pantallas (recomendado si no querés perder contenido)');
    console.log('  15 a 30 = Píxeles ocultos detrás del marco físico entre pantallas vecinas');
    ask('Ingresá píxeles de bisel (0-400) [actual ' + cfg.bezelPx + ']: ', function (ans) {
        var b = parseInt(ans, 10);
        if (!isNaN(b) && b >= 0 && b <= 400) {
            cfg.bezelPx = b;
            dirty = true;
        }
        showMainMenu();
    });
}

function menuSync() {
    console.log('\n--- MODO DE SINCRONIZACIÓN ---');
    console.log('  1) NTP Automático (Sin equipo Master extra: todas usan reloj del sistema)');
    console.log('  2) Master LAN (Esta pantalla será el reloj maestro en la red local)');
    console.log('  3) Slave LAN (Esta pantalla seguirá la IP del Master en la red local)');
    ask('Elegí sincronización [1-3]: ', function (ans) {
        if (ans === '1') {
            cfg.syncMode = 'ntp';
            cfg.masterIp = '';
            dirty = true;
            return showMainMenu();
        }
        if (ans === '2') {
            cfg.syncMode = 'master';
            cfg.masterIp = '';
            dirty = true;
            return showMainMenu();
        }
        if (ans === '3') {
            return ask('Ingresá la IP local del Master (ej. 192.168.1.50): ', function (ip) {
                if (ip) {
                    cfg.syncMode = 'master';
                    cfg.masterIp = ip;
                    dirty = true;
                }
                showMainMenu();
            });
        }
        showMainMenu();
    });
}

function saveAndExit() {
    saveWallJson(cfg);
    console.log('\n[+] Configuración guardada en ' + WALL_JSON);

    var rotChanged = (cfg.orientation !== initialConfigTxtRot);
    if (rotChanged) {
        console.log('[+] Actualizando orientación en config.txt -> ' + orientationLabel(cfg.orientation));
        var wRes = writeHdmiRotate(cfg.orientation);
        if (!wRes.ok) {
            console.log('[!] No se pudo actualizar config.txt automáticamente: ' + wRes.reason);
        }
    }

    console.log('[+] Limpiando caché previo (optimized / seamless) para regenerar recorte...');
    clearWallCaches();
    if (cfg.activationMode === 'server') {
        console.log('[i] Modo REMOTO activo: esta Pi activará o desactivará el Video Wall según la opción Video Wall en tbee.tv.');
    }

    if (rotChanged) {
        ask('La orientación HDMI cambió. ¿Reiniciar la Raspberry Pi ahora? (s/N): ', function (ans) {
            rl.close();
            if (ans.toLowerCase() === 's' || ans.toLowerCase() === 'y' || ans.toLowerCase() === 'si') {
                console.log('Reiniciando...');
                try { execSync('sudo reboot', { stdio: 'inherit' }); } catch (e) {}
            } else {
                restartUrpService();
                console.log('Recordá ejecutar "sudo reboot" para aplicar la rotación física completa.');
            }
            process.exit(0);
        });
    } else {
        console.log('[+] Reiniciando servicio URPPI3...');
        restartUrpService();
        console.log('[OK] ¡Listo! Podés ver el estado en vivo con: pm2 logs URP');
        rl.close();
        process.exit(0);
    }
}

showMainMenu();
URP_WALL_NODE_EOF

exec node -e "$NODE_SCRIPT" -- "$@"
