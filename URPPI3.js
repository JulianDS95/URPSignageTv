var URPActive = true;
var URPType = 'URPPI3';
var URPVersion = '2.4.1';
var URPUpdated = false;
var isArm = process.arch === 'arm' || process.arch === 'arm64';
var isLinux = process.platform === 'linux';
var baseUrl = 'tbee.tv';
var offline = false;
var procBackgroundImage = null;
var procImage, pidImage, procVideo, pidVideo, procBrowser, pidBrowser;
var isPlaying = false;
var playing = null;
var refreshIntervalId = null;
var WSCheckIntervalId = null;
var WSCheckTime = 60000;
var i = 0;
var shifts = 1;
var shifts_socket_id = null;
var ftp = null;
var FTPcontents = [];
var FTPuploads = [];
var ftpWorking = false;
var basePath = '/home/pi/URP/';
var contentBasePath = basePath + 'content/';
var tempFolderPath = basePath + 'temp/';
var seamlessBasePath = basePath + 'seamless/';
var optimizedBasePath = basePath + 'optimized/';
var URPdata = {};
var schedule = [];
var contents = [];
var wall = [];
var max = 0;
var iConn = false;
var URPPort = 8090;
var URPSocketPort = 8092;
var ftpHost, ftpPort, ftpUser, ftpPass, ftpBasePath;
var URPFreeSpace = '-';
var temperature = 0;
var memPercentUsed = 0;
var cpuUsage = 0;
var blockPlaying = 0;
var comandPlaying;
var respuesta = false;
var isRendering = false;
var isConcatenating = false;
var playContentRunning = false;
var path = require('path');
var macAdd = '';
var lista = [];
var URPNowPlaying = 0;
var fs = require('fs');
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;
var spawn = require('child_process').spawn;
var net = require('net');
var _ = require('lodash');
var async = require('async');

var osMod = require('os');
var hasOmxplayer = false;
var hasMpv = false;
var hasCurl = false;
var hasNice = false;
var piModelStr = '';
var totalRamMB = Math.round(osMod.totalmem() / (1024 * 1024));
var isPi4Or5 = false;
var isLowPowerPi = false;
var bootGraceDone = false;
setTimeout(function () {
    bootGraceDone = true;
    if (Array.isArray(schedule) && schedule.length > 0) {
        checkSchedule();
    }
}, 5000);

if (isArm || isLinux) {
    try { execSync('command -v omxplayer', { stdio: 'ignore' }); hasOmxplayer = true; } catch (e) {}
    try { execSync('command -v mpv', { stdio: 'ignore' }); hasMpv = true; } catch (e) {}
    try { execSync('command -v curl', { stdio: 'ignore' }); hasCurl = true; } catch (e) {}
    try { execSync('command -v nice', { stdio: 'ignore' }); hasNice = true; } catch (e) {}
    try {
        if (fs.existsSync('/proc/device-tree/model')) {
            piModelStr = fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim();
        }
    } catch (e) {}
    isPi4Or5 = /Pi 4|Pi 5|Pi 400|Compute Module 4|Compute Module 5/i.test(piModelStr);
    isLowPowerPi = isArm && !isPi4Or5 && (totalRamMB <= 1536 || /Pi 3|Pi 2|Pi Zero/i.test(piModelStr));
}

// ==============================================================================
// 0B. MODO VIDEO WALL MODULAR (Leido desde /home/pi/URP/wall.json)
//     Si wall.json no existe o enabled=false, URPPI3 opera 100% en modo normal.
// ==============================================================================
var wallConfigPath = basePath + 'wall.json';
var wallConfig = {
    enabled: false,
    activationMode: 'server',
    mode: 'mirror',
    screenId: 1,
    rows: 1,
    cols: 1,
    row: 0,
    col: 0,
    bezelPx: 0,
    orientation: 0,
    syncMode: 'ntp',
    masterIp: ''
};
var wallConfigMtime = 0;
var lastWallSignatureLogged = '';

function loadWallConfig() {
    try {
        if (!fs.existsSync(wallConfigPath)) {
            wallConfig = {
                enabled: false, activationMode: 'server', mode: 'mirror', screenId: 1,
                rows: 1, cols: 1, row: 0, col: 0, bezelPx: 0,
                orientation: 0, syncMode: 'ntp', masterIp: ''
            };
            wallConfigMtime = 0;
            return wallConfig;
        }
        var st = fs.statSync(wallConfigPath);
        if (st.mtime.getTime() === wallConfigMtime && wallConfigMtime > 0) {
            return wallConfig;
        }
        var parsed = JSON.parse(fs.readFileSync(wallConfigPath, 'utf8'));
        var rows = Math.max(1, parseInt(parsed.rows, 10) || 1);
        var cols = Math.max(1, parseInt(parsed.cols, 10) || 1);
        var total = rows * cols;
        var screenId = Math.min(total, Math.max(1, parseInt(parsed.screenId, 10) || 1));
        var row = (typeof parsed.row === 'number' && parsed.row >= 0 && parsed.row < rows)
            ? parsed.row
            : Math.floor((screenId - 1) / cols);
        var col = (typeof parsed.col === 'number' && parsed.col >= 0 && parsed.col < cols)
            ? parsed.col
            : ((screenId - 1) % cols);
        var actMode = (parsed.activationMode === 'server' || parsed.activationMode === 'local')
            ? parsed.activationMode
            : 'local';

        wallConfig = {
            enabled: Boolean(parsed.enabled),
            activationMode: actMode,
            mode: (parsed.mode === 'mirror') ? 'mirror' : 'tile',
            screenId: screenId,
            rows: rows,
            cols: cols,
            row: row,
            col: col,
            bezelPx: Math.max(0, Math.min(400, parseInt(parsed.bezelPx, 10) || 0)),
            orientation: [0, 1, 2, 3].indexOf(parseInt(parsed.orientation, 10)) !== -1 ? parseInt(parsed.orientation, 10) : 0,
            syncMode: (parsed.syncMode === 'master') ? 'master' : 'ntp',
            masterIp: String(parsed.masterIp || '').trim()
        };
        wallConfigMtime = st.mtime.getTime();

        var sig = wallConfig.activationMode + '_' + wallConfig.enabled + '_' + wallConfig.mode + '_' + wallConfig.rows + 'x' + wallConfig.cols + '_id' + wallConfig.screenId + '_' + wallConfig.syncMode;
        if (sig !== lastWallSignatureLogged) {
            lastWallSignatureLogged = sig;
            if (wallConfig.activationMode === 'server' || wallConfig.enabled) {
                console.log('[VIDEOWALL] Config -> control=' + wallConfig.activationMode + ', enabled=' + wallConfig.enabled + ', modo=' + wallConfig.mode + ', matriz=' + wallConfig.rows + 'x' + wallConfig.cols + ', pantalla #' + wallConfig.screenId + ' (f' + (wallConfig.row + 1) + ',c' + (wallConfig.col + 1) + '), bisel=' + wallConfig.bezelPx + 'px, sync=' + wallConfig.syncMode + (wallConfig.masterIp ? ('(' + wallConfig.masterIp + ')') : ''));
            }
        }
    } catch (e) {}
    return wallConfig;
}

function isWallActive() {
    loadWallConfig();
    if (!wallConfig) return false;
    if (wallConfig.activationMode === 'server') {
        return Boolean(URPdata && URPdata.isVideoWall);
    }
    return Boolean(wallConfig.enabled);
}

function isWallTileActive() {
    return isWallActive() && wallConfig.mode === 'tile' && (wallConfig.rows > 1 || wallConfig.cols > 1);
}

function getWallSignature() {
    if (!isWallActive()) return '';
    if (!isWallTileActive()) return 'WM';
    return 'WT' + wallConfig.rows + 'x' + wallConfig.cols + '_r' + wallConfig.row + 'c' + wallConfig.col + (wallConfig.bezelPx > 0 ? ('_b' + wallConfig.bezelPx) : '');
}

function getWallCropFilter() {
    var rows = wallConfig.rows;
    var cols = wallConfig.cols;
    var row = wallConfig.row;
    var col = wallConfig.col;
    var bezel = wallConfig.bezelPx || 0;
    var bx = bezel * (cols - 1);
    var by = bezel * (rows - 1);
    return 'crop=trunc((iw-' + bx + ')/' + cols + '/2)*2:trunc((ih-' + by + ')/' + rows + '/2)*2:floor(' + col + '*(iw+' + bezel + ')/' + cols + '):floor(' + row + '*(ih+' + bezel + ')/' + rows + ')';
}

loadWallConfig();

function getTargetVideoDims() {
    var isVert = isPortraitOrientation();
    // En Pi 3B+/Zero 2W con mpv (Bookworm/Trixie sin omxplayer), 720p H.264 Baseline L3.1 garantiza decodificación fluida sin tirones
    var use720p = isLowPowerPi && !hasOmxplayer;
    var longEdge = use720p ? 1280 : 1920;
    var shortEdge = use720p ? 720 : 1080;
    return {
        width: isVert ? shortEdge : longEdge,
        height: isVert ? longEdge : shortEdge,
        use720p: use720p,
        profile: use720p ? 'baseline' : 'main',
        level: use720p ? '3.1' : '4.0',
        crf: use720p ? '24' : '22',
        maxRate: use720p ? '2500k' : '4200k',
        bufSize: use720p ? '5000k' : '8400k',
        threads: isLowPowerPi ? '1' : '2'
    };
}

function spawnFfmpegLowPriority(ffArgs) {
    if (isLinux && hasNice) {
        return spawn('nice', ['-n', '15', 'ffmpeg'].concat(ffArgs), { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    return spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
}

// ==============================================================================
// 1. NEUTRALIZACION DEL ESCRITORIO + CORTINA NEGRA PERMANENTE EN X11
// ==============================================================================
var curtainProc = null;
var BLACK_CURTAIN_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC';

function ensureBlackCurtainAsset() {
    var curtainPath = basePath + 'black_curtain.png';
    try {
        if (!fs.existsSync(basePath)) fs.mkdirSync(basePath);
        if (!fs.existsSync(curtainPath)) {
            fs.writeFileSync(curtainPath, Buffer.from(BLACK_CURTAIN_PNG_B64, 'base64'));
        }
    } catch (e) {}
    return curtainPath;
}

var osScreenRotated = false;
var lastDisplayRotLog = '';

function getXauthPath() {
    var uid = (typeof process.getuid === 'function') ? process.getuid() : 1000;
    var homeDir = process.env.HOME || '/home/pi';
    var candidates = [
        process.env.XAUTHORITY,
        '/home/pi/.Xauthority',
        homeDir + '/.Xauthority',
        '/run/user/' + uid + '/gdm/Xauthority'
    ];
    for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
    }
    return '/home/pi/.Xauthority';
}

function getWaylandEnv() {
    var uid = (typeof process.getuid === 'function') ? process.getuid() : 1000;
    var runtimeDir = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
    var waylandDisp = process.env.WAYLAND_DISPLAY || '';
    if (!waylandDisp && fs.existsSync(runtimeDir)) {
        try {
            var entries = fs.readdirSync(runtimeDir);
            for (var i = 0; i < entries.length; i++) {
                if (/^wayland-[0-9]+$/.test(entries[i])) {
                    waylandDisp = entries[i];
                    break;
                }
            }
        } catch (e) {}
    }
    return {
        runtimeDir: runtimeDir,
        waylandDisplay: waylandDisp
    };
}

function getGuiEnv() {
    var wl = getWaylandEnv();
    var extra = {
        DISPLAY: process.env.DISPLAY || ':0',
        XAUTHORITY: getXauthPath(),
        XDG_RUNTIME_DIR: wl.runtimeDir
    };
    if (wl.waylandDisplay) {
        extra.WAYLAND_DISPLAY = wl.waylandDisplay;
    }
    return Object.assign({}, process.env, extra);
}

function readHdmiRotateFromConfig() {
    var cfgPaths = ['/boot/firmware/config.txt', '/boot/config.txt'];
    for (var i = 0; i < cfgPaths.length; i++) {
        try {
            if (!fs.existsSync(cfgPaths[i])) continue;
            var raw = fs.readFileSync(cfgPaths[i], 'utf8');
            var lines = raw.split(/\r?\n/);
            var found = null;
            for (var j = 0; j < lines.length; j++) {
                var line = lines[j].trim();
                if (!line || line.charAt(0) === '#') continue;
                var m = line.match(/^display_hdmi_rotate\s*=\s*([0-3])/i);
                if (m) found = parseInt(m[1], 10);
            }
            if (found !== null) return found;
        } catch (e) {}
    }
    if (isWallActive() && wallConfig.orientation >= 0 && wallConfig.orientation <= 3) {
        return wallConfig.orientation;
    }
    return null;
}

function isPortraitOrientation() {
    if (URPdata && URPdata.vertical) return true;
    var rot = readHdmiRotateFromConfig();
    return (rot === 1 || rot === 3);
}

function getMpvVideoRotateDeg() {
    var cfgRot = readHdmiRotateFromConfig();
    if (!cfgRot || cfgRot === 0 || osScreenRotated) return 0;
    if (cfgRot === 1) return 90;
    if (cfgRot === 2) return 180;
    if (cfgRot === 3) return 270;
    return 0;
}

function buildDisplayRotationScript(cfgRot) {
    var wl = getWaylandEnv();
    var xrandrDir = (cfgRot === 1) ? 'right' : (cfgRot === 2 ? 'inverted' : 'left');
    var wlrTrans = (cfgRot === 1) ? '90' : (cfgRot === 2 ? '180' : '270');

    return "export DISPLAY=:0; export XAUTHORITY=\"" + getXauthPath() + "\"; " +
           "export XDG_RUNTIME_DIR=\"" + wl.runtimeDir + "\"; " +
           (wl.waylandDisplay ? "export WAYLAND_DISPLAY=\"" + wl.waylandDisplay + "\"; " : "") +
           "OS_ROTATED=0; DID_CHANGE=0; BACKEND=none; " +
           "OUT=$(xrandr --query 2>/dev/null | awk '/ connected/ && $1 !~ /^XWAYLAND/{print $1; exit}'); " +
           "if [ -n \"$OUT\" ]; then " +
           "  BACKEND=x11; " +
           "  CUR=$(xrandr --query 2>/dev/null | awk -v o=\"$OUT\" '$1==o{print; exit}'); " +
           "  RES=$(echo \"$CUR\" | grep -oE '[0-9]+x[0-9]+' | head -n1); " +
           "  W=$(echo \"$RES\" | cut -dx -f1); H=$(echo \"$RES\" | cut -dx -f2); " +
           "  ALREADY=0; " +
           "  if [ \"" + cfgRot + "\" = \"2\" ]; then " +
           "    echo \"$CUR\" | grep -qE ' inverted [(]' && ALREADY=1; " +
           "  else " +
           "    if [ -n \"$W\" ] && [ -n \"$H\" ] && [ \"$W\" -lt \"$H\" ] 2>/dev/null; then ALREADY=1; fi; " +
           "    echo \"$CUR\" | grep -qE ' (right|left) [(]' && ALREADY=1; " +
           "  fi; " +
           "  if [ \"$ALREADY\" = \"0\" ]; then " +
           "    if xrandr --output \"$OUT\" --rotate " + xrandrDir + " 2>/dev/null; then " +
           "      DID_CHANGE=1; OS_ROTATED=1; " +
           "    fi; " +
           "  else " +
           "    OS_ROTATED=1; " +
           "  fi; " +
           "fi; " +
           "if [ \"$OS_ROTATED\" = \"0\" ] && command -v wlr-randr >/dev/null 2>&1; then " +
           "  WOUT=$(wlr-randr 2>/dev/null | awk '/^HDMI|^DP|^DSI/{print $1; exit}'); " +
           "  if [ -n \"$WOUT\" ]; then " +
           "    BACKEND=wayland; " +
           "    CUR_T=$(wlr-randr 2>/dev/null | awk -v o=\"$WOUT\" '$0 ~ \"^\"o{f=1;next} f && /Transform:/{print $2;exit}'); " +
           "    if [ \"$CUR_T\" = \"" + wlrTrans + "\" ]; then " +
           "      OS_ROTATED=1; " +
           "    elif wlr-randr --output \"$WOUT\" --transform " + wlrTrans + " 2>/dev/null; then " +
           "      DID_CHANGE=1; OS_ROTATED=1; " +
           "    fi; " +
           "  fi; " +
           "fi; " +
           "echo \"OS_ROTATED=$OS_ROTATED DID_CHANGE=$DID_CHANGE BACKEND=$BACKEND\"";
}

function handleDisplayRotationResult(cfgRot, stdout) {
    var prevOsRot = osScreenRotated;
    var isOsRot = Boolean(stdout && stdout.indexOf('OS_ROTATED=1') !== -1);
    var didChange = Boolean(stdout && stdout.indexOf('DID_CHANGE=1') !== -1);
    osScreenRotated = isOsRot;

    var summary = 'cfgRot=' + cfgRot + ' osRotated=' + osScreenRotated + ' stdout=' + String(stdout || '').trim();
    if (summary !== lastDisplayRotLog) {
        lastDisplayRotLog = summary;
        if (osScreenRotated) {
            console.log('[DISPLAY] Rotación de sistema activa (display_hdmi_rotate=' + cfgRot + ').');
        } else {
            console.log('[DISPLAY] Sistema sin rotación HDMI nativa (display_hdmi_rotate=' + cfgRot + '). Usando rotación GPU por reproductor (--video-rotate=' + getMpvVideoRotateDeg() + ').');
        }
    }

    if (didChange && curtainProc != null) {
        try { process.kill(curtainProc.pid, 'SIGKILL'); } catch (e) {}
        curtainProc = null;
    }
    if (prevOsRot !== osScreenRotated && isPlaying) {
        setTimeout(function () { playCurrentIndex(); }, 200);
    }
    return didChange;
}

function refreshDisplayRotationSync() {
    if (!isArm && !isLinux) return;
    var cfgRot = readHdmiRotateFromConfig();
    if (cfgRot === null || cfgRot === 0) {
        osScreenRotated = false;
        return;
    }
    try {
        var out = execSync(buildDisplayRotationScript(cfgRot), { timeout: 3000, encoding: 'utf8' });
        handleDisplayRotationResult(cfgRot, out);
    } catch (e) {
        osScreenRotated = false;
    }
}

function applyDisplayRotationIfNeeded(callback) {
    if (!isArm && !isLinux) {
        if (callback) callback(false);
        return;
    }
    var cfgRot = readHdmiRotateFromConfig();
    if (cfgRot === null || cfgRot === 0) {
        osScreenRotated = false;
        if (callback) callback(false);
        return;
    }

    exec(buildDisplayRotationScript(cfgRot), function (err, stdout) {
        var didChange = handleDisplayRotationResult(cfgRot, stdout);
        if (callback) callback(didChange);
    });
}
refreshDisplayRotationSync();

function startBlackCurtain() {
    if (!isArm && !isLinux) return;
    if (!URPActive || curtainProc != null) return;
    var curtainPath = ensureBlackCurtainAsset();
    if (!fs.existsSync(curtainPath)) return;
    try {
        var env = Object.assign({}, process.env, { DISPLAY: ':0', XAUTHORITY: getXauthPath() });
        curtainProc = spawn('feh', ['-F', '-Z', '-x', '-Y', '-B', 'black', '-q', '--hide-pointer', curtainPath], { env: env });
        curtainProc.on('error', function () { curtainProc = null; });
        curtainProc.on('exit', function () {
            curtainProc = null;
            if (URPActive) {
                setTimeout(startBlackCurtain, 1000);
            }
        });
    } catch (e) {
        curtainProc = null;
    }
}

function suppressDesktopPopups() {
    if (!isArm && !isLinux) return;
    var xEnv = "export DISPLAY=:0; export XAUTHORITY=\"" + getXauthPath() + "\"; ";
    // No invocar pcmanfm --desktop-off en bucle cada 20s porque dispara 'Drawing desktop' y consume CPU si lxsession lo reinicia
    var cmd = xEnv + "pkill -9 -f 'lwrespawn.*(pcmanfm|wf-panel)' 2>/dev/null || true; " +
              "pkill -9 -x wf-panel-pi lxpanel xcompmgr picom compton mako dunst xfce4-notifyd notification-daemon lxqt-notificationd piwiz blueman-applet nm-applet zenity yad 2>/dev/null || true; " +
              xEnv + "xset s off -dpms s noblank 2>/dev/null || true";
    exec(cmd, function () {});
}

function writeCleanAutostartDir(dirPath, cleanContent) {
    try {
        ensureDir(dirPath);
        var asPath = dirPath + '/autostart';
        var needsWrite = true;
        var extraLines = [];
        if (fs.existsSync(asPath)) {
            var cur = fs.readFileSync(asPath, 'utf8');
            if (cur.indexOf('#URP_CLEAN') !== -1 && cur.indexOf('pcmanfm') === -1 && cur.indexOf('lxpanel') === -1 && cur.indexOf('wf-panel-pi') === -1) {
                needsWrite = false;
            } else {
                var lines = cur.split(/\r?\n/);
                for (var li = 0; li < lines.length; li++) {
                    if (lines[li].indexOf('xrandr') !== -1) extraLines.push(lines[li]);
                }
            }
        }
        if (needsWrite) {
            var finalStr = cleanContent + (extraLines.length > 0 ? extraLines.join('\n') + '\n' : '');
            fs.writeFileSync(asPath, finalStr, 'utf8');
        }
    } catch (e) {}
}

function neutralizeDesktop() {
    if (!isArm && !isLinux) return;
    try {
        var homeBase = process.env.HOME || '/home/pi';
        var pcmanDirs = [
            '/home/pi/.config/pcmanfm/LXDE-pi',
            homeBase + '/.config/pcmanfm/LXDE-pi',
            homeBase + '/.config/pcmanfm/LXDE-pi-x',
            homeBase + '/.config/pcmanfm/rpd-x',
            homeBase + '/.config/pcmanfm/default'
        ];
        for (var p = 0; p < pcmanDirs.length; p++) {
            try {
                ensureDir(pcmanDirs[p]);
                fs.writeFileSync(pcmanDirs[p] + '/desktop-items-0.conf',
                    "[*]\nwallpaper_mode=color\nwallpaper=\ndesktop_bg=#000000\ndesktop_fg=#000000\ndesktop_shadow=#000000\nshow_documents=0\nshow_trash=0\nshow_mounts=0\n");
                fs.writeFileSync(pcmanDirs[p] + '/pcmanfm.conf',
                    "[config]\nbm_open_method=0\n\n[volume]\nmount_on_startup=0\nmount_removable=0\nautorun=0\n");
            } catch (ce) {}
        }

        // Anular pcmanfm --desktop y paneles en TODOS los perfiles de sesion (LXDE-pi, LXDE-pi-x, rpd-x, openbox, labwc)
        var cleanX11As = "#URP_CLEAN\n@xset s off\n@xset -dpms\n@xset s noblank\n@xhost +local:\n";
        var lxDirs = [
            homeBase + '/.config/lxsession/LXDE-pi',
            homeBase + '/.config/lxsession/LXDE-pi-x',
            homeBase + '/.config/lxsession/rpd-x',
            homeBase + '/.config/openbox'
        ];
        for (var ld = 0; ld < lxDirs.length; ld++) {
            writeCleanAutostartDir(lxDirs[ld], cleanX11As);
        }

        // Neutralizar labwc autostart para que tampoco dispare lwrespawn pcmanfm --desktop
        try {
            var labwcDir = homeBase + '/.config/labwc';
            ensureDir(labwcDir);
            var labwcAs = labwcDir + '/autostart';
            if (!fs.existsSync(labwcAs) || fs.readFileSync(labwcAs, 'utf8').indexOf('#URP_CLEAN') === -1) {
                fs.writeFileSync(labwcAs, "#URP_CLEAN\npkill -9 -f 'lwrespawn.*(pcmanfm|wf-panel)' 2>/dev/null || true\npkill -9 mako wf-panel-pi 2>/dev/null || true\n", 'utf8');
            }
        } catch (le) {}

        // Ocultar autostart de pcmanfm/notificaciones en ~/.config/autostart
        try {
            var xdgAuto = homeBase + '/.config/autostart';
            ensureDir(xdgAuto);
            var hiddenDesks = ['pcmanfm.desktop', 'rpd-wallpaper.desktop', 'piwiz.desktop', 'xfce4-notifyd.desktop', 'notification-daemon.desktop', 'lxqt-notificationd.desktop', 'blueman.desktop', 'nm-applet.desktop', 'update-notifier.desktop', 'package-update-indicator.desktop', 'pk-update-icon.desktop'];
            for (var hd = 0; hd < hiddenDesks.length; hd++) {
                var dp = xdgAuto + '/' + hiddenDesks[hd];
                if (!fs.existsSync(dp)) {
                    fs.writeFileSync(dp, "[Desktop Entry]\nHidden=true\n", 'utf8');
                }
            }
        } catch (ae) {}

        var xEnv = "export DISPLAY=:0; export XAUTHORITY=\"" + getXauthPath() + "\"; ";
        var cmd = xEnv + "pkill -9 -f 'lwrespawn.*(pcmanfm|wf-panel)' 2>/dev/null || true; " +
                  "if pgrep -x pcmanfm >/dev/null 2>&1; then " + xEnv + "pcmanfm --desktop-off 2>/dev/null || true; fi; " +
                  "pkill -9 -x wf-panel-pi lxpanel mako dunst xfce4-notifyd notification-daemon lxqt-notificationd piwiz blueman-applet nm-applet zenity yad 2>/dev/null || true; " +
                  xEnv + "xsetroot -solid black 2>/dev/null; " +
                  xEnv + "xset s off -dpms s noblank 2>/dev/null; " +
                  xEnv + "pkill -9 feh 2>/dev/null; " +
                  xEnv + "unclutter -idle 0.1 -root 2>/dev/null &";
        exec(cmd, function () {
            applyDisplayRotationIfNeeded(function () {
                startBlackCurtain();
            });
        });
    } catch (e) {}
}
neutralizeDesktop();
setInterval(function () {
    suppressDesktopPopups();
    applyDisplayRotationIfNeeded();
}, 20000);

function killBackground() {
    if (procBackgroundImage != null) {
        try { process.kill(procBackgroundImage.pid, 'SIGKILL'); } catch (e) {}
        procBackgroundImage = null;
    }
}

var setBackground = function (callback) {
    if ((isArm || isLinux) && !isPlaying) {
        var bgPath = basePath + 'background.png';
        if (procBackgroundImage == null && fs.existsSync(bgPath)) {
            try {
                procBackgroundImage = spawn('feh', ['-x', '-q', '-F', bgPath], {
                    env: Object.assign({}, process.env, { DISPLAY: ':0', XAUTHORITY: '/home/pi/.Xauthority' })
                });
                procBackgroundImage.on('error', function () { procBackgroundImage = null; });
            } catch (e) {
                procBackgroundImage = null;
            }
            if (callback) setTimeout(callback, 500);
        } else {
            if (callback) callback();
        }
    } else {
        if (callback) callback();
    }
};

// ==============================================================================
// 2. MOTOR DE REPRODUCCION NATIVO (RPI 3B+: OMXPLAYER | RPI 4/5: MPV) + FEH
//   - Limpieza síncrona antes de lanzar cada reproductor (cero race conditions)
//   - Detección automática de omxplayer (VideoCore IV) o mpv (KMS/DRM en RPi 4/5)
//   - Capa negra fija (-b) y --layer 10000 para evitar destellos del escritorio
// ==============================================================================
var currentPlaylist = [];
var currentMediaIndex = 0;
var activePlayerProcess = null;
var activeFehProcess = null;
var fehCurrentFile = '';
var imageTimer = null;
var filesPlaying = [];
var playbackToken = 0;

function killMediaPlayersSync() {
    if (!isArm && !isLinux) return;
    try {
        // No usar killall feh aquí para preservar la cortina negra permanente (curtainProc)
        execSync("killall -9 omxplayer.bin omxplayer mpv 2>/dev/null || true", { stdio: 'ignore' });
    } catch (e) {}
}

// ==============================================================================
// 2B. MOTOR DE SINCRONIZACION VIDEO WALL (MPV IPC: NTP SIN MASTER Y MASTER/SLAVE)
// ==============================================================================
var mpvIpcSocketPath = '/tmp/mpv-urp.sock';
var wallSyncTimer = null;
var wallSyncBusy = false;
var lastWallSeekAt = 0;
var wallMasterState = { timePos: 0, duration: 0, ts: 0, file: '' };
var wallSyncStatus = { active: false, mode: '', driftMs: 0, speed: 1, targetPos: 0, curPos: 0, lastSyncAt: 0, lastError: '' };

function stopWallSync() {
    if (wallSyncTimer) {
        clearInterval(wallSyncTimer);
        wallSyncTimer = null;
    }
    wallSyncBusy = false;
    wallSyncStatus.active = false;
}

function mpvIpcRequest(commands, callback) {
    if (!fs.existsSync(mpvIpcSocketPath)) {
        return callback(new Error('mpv ipc socket unavailable'));
    }
    var settled = false;
    var sock = null;
    var buf = '';
    var results = {};

    var finish = function (err, res) {
        if (settled) return;
        settled = true;
        try { if (sock) sock.destroy(); } catch (e) {}
        callback(err, res);
    };

    var timer = setTimeout(function () {
        finish(new Error('mpv ipc timeout'));
    }, 500);

    try {
        sock = net.connect(mpvIpcSocketPath, function () {
            try {
                for (var c = 0; c < commands.length; c++) {
                    sock.write(JSON.stringify({ command: commands[c], request_id: c + 1 }) + '\n');
                }
            } catch (we) {
                clearTimeout(timer);
                finish(we);
            }
        });
        sock.on('data', function (chunk) {
            buf += chunk.toString('utf8');
            var lines = buf.split('\n');
            buf = lines.pop();
            for (var li = 0; li < lines.length; li++) {
                var ln = lines[li].trim();
                if (!ln) continue;
                try {
                    var msg = JSON.parse(ln);
                    if (typeof msg.request_id === 'number') {
                        results[msg.request_id] = msg;
                    }
                } catch (pe) {}
            }
            if (Object.keys(results).length >= commands.length) {
                clearTimeout(timer);
                finish(null, results);
            }
        });
        sock.on('error', function (err) {
            clearTimeout(timer);
            finish(err);
        });
    } catch (e) {
        clearTimeout(timer);
        finish(e);
    }
}

function applyWallTargetDrift(curPos, duration, targetPos) {
    var diff = targetPos - curPos;
    if (diff > duration / 2) diff -= duration;
    if (diff < -duration / 2) diff += duration;

    wallSyncStatus.curPos = Number(curPos.toFixed(3));
    wallSyncStatus.targetPos = Number(targetPos.toFixed(3));
    wallSyncStatus.driftMs = Math.round(diff * 1000);
    wallSyncStatus.lastSyncAt = Date.now();
    wallSyncStatus.lastError = '';

    // Evitar ajustes justo sobre el salto del bucle final -> inicio
    if (curPos < 0.8 || curPos > duration - 0.8 || targetPos < 0.8 || targetPos > duration - 0.8) {
        return;
    }

    var absDiff = Math.abs(diff);
    if (absDiff <= 0.05) {
        if (wallSyncStatus.speed !== 1) {
            wallSyncStatus.speed = 1;
            mpvIpcRequest([['set_property', 'speed', 1]], function () {});
        }
    } else if (absDiff <= 0.8) {
        var nextSpeed = diff > 0 ? 1.03 : 0.97;
        if (wallSyncStatus.speed !== nextSpeed) {
            wallSyncStatus.speed = nextSpeed;
            mpvIpcRequest([['set_property', 'speed', nextSpeed]], function () {});
        }
    } else {
        var now = Date.now();
        if (now - lastWallSeekAt > 4000) {
            lastWallSeekAt = now;
            wallSyncStatus.speed = 1;
            console.log('[VIDEOWALL:SYNC] Re-sincronizando pos ' + curPos.toFixed(2) + 's -> ' + targetPos.toFixed(2) + 's (drift ' + wallSyncStatus.driftMs + 'ms)');
            mpvIpcRequest([['set_property', 'speed', 1], ['set_property', 'time-pos', targetPos]], function () {});
        }
    }
}

function startWallSync(currentFile) {
    stopWallSync();
    if (!isWallActive()) return;
    wallSyncStatus.active = true;
    wallSyncStatus.mode = wallConfig.syncMode + (wallConfig.masterIp ? '->' + wallConfig.masterIp : '');
    wallSyncStatus.speed = 1;

    wallSyncTimer = setInterval(function () {
        if (!isPlaying || !isWallActive() || currentPlaylist.length !== 1 || wallSyncBusy) return;
        wallSyncBusy = true;

        mpvIpcRequest([['get_property', 'time-pos'], ['get_property', 'duration']], function (err, res) {
            if (err || !res || !res[1] || !res[2] || res[1].error !== 'success' || res[2].error !== 'success') {
                wallSyncBusy = false;
                if (err) wallSyncStatus.lastError = err.message;
                return;
            }
            var curPos = parseFloat(res[1].data);
            var duration = parseFloat(res[2].data);
            if (isNaN(curPos) || isNaN(duration) || duration <= 1.5) {
                wallSyncBusy = false;
                return;
            }

            // En modo Master LAN (sin masterIp), esta Raspberry sirve el reloj maestro y no se corrige
            if (wallConfig.syncMode === 'master' && !wallConfig.masterIp) {
                wallMasterState = {
                    timePos: curPos,
                    duration: duration,
                    ts: Date.now(),
                    file: path.basename(currentFile || '')
                };
                wallSyncStatus.curPos = Number(curPos.toFixed(3));
                wallSyncStatus.targetPos = wallSyncStatus.curPos;
                wallSyncStatus.driftMs = 0;
                wallSyncStatus.lastSyncAt = Date.now();
                wallSyncStatus.lastError = '';
                if (wallSyncStatus.speed !== 1) {
                    wallSyncStatus.speed = 1;
                    mpvIpcRequest([['set_property', 'speed', 1]], function () {});
                }
                wallSyncBusy = false;
                return;
            }

            // Modo Slave LAN contra Master IP
            if (wallConfig.syncMode === 'master' && wallConfig.masterIp) {
                var reqStart = Date.now();
                request({
                    url: 'http://' + wallConfig.masterIp + ':' + URPPort + '/wall/sync',
                    json: true,
                    timeout: 1200
                }, function (rErr, rRes, body) {
                    wallSyncBusy = false;
                    if (rErr || !rRes || rRes.statusCode !== 200 || !body || typeof body.timePos !== 'number') {
                        wallSyncStatus.lastError = rErr ? rErr.message : 'master_unavailable';
                        return;
                    }
                    var rtt = Date.now() - reqStart;
                    if (body.duration && Math.abs(body.duration - duration) > 1.5) {
                        wallSyncStatus.lastError = 'transitioning_block';
                        return;
                    }
                    var targetPos = (body.timePos + (rtt / 2000)) % duration;
                    applyWallTargetDrift(curPos, duration, targetPos);
                });
                return;
            }

            // Modo NTP automático (sin equipo Master extra)
            var targetPosNtp = ((Date.now() / 1000) % duration);
            applyWallTargetDrift(curPos, duration, targetPosNtp);
            wallSyncBusy = false;
        });
    }, 1500);
}

// Detención segura de procesos de medios anteriores
function stopCurrentMedia(callback) {
    playbackToken++; // Invalida cualquier callback pendiente de procesos o temporizadores anteriores
    stopWallSync();
    if (imageTimer) {
        clearTimeout(imageTimer);
        imageTimer = null;
    }
    if (activePlayerProcess != null) {
        try {
            activePlayerProcess.removeAllListeners('exit');
            activePlayerProcess.removeAllListeners('error');
            activePlayerProcess.kill('SIGKILL');
        } catch (e) {}
        activePlayerProcess = null;
    }
    if (activeFehProcess != null) {
        try {
            activeFehProcess.removeAllListeners('exit');
            activeFehProcess.removeAllListeners('error');
            activeFehProcess.kill('SIGKILL');
        } catch (e) {}
        activeFehProcess = null;
        fehCurrentFile = '';
    }
    killMediaPlayersSync();
    if (typeof callback === 'function') setTimeout(callback, 50);
}

// Reproducción secuencial limpia de elementos (Video con OMX/MPV | Imagen con FEH)
function playCurrentIndex() {
    if (!isPlaying || currentPlaylist.length === 0) return;

    if (currentMediaIndex >= currentPlaylist.length) {
        currentMediaIndex = 0; // Reinicio cíclico
    }

    var item = currentPlaylist[currentMediaIndex];
    if (item && item.idContent) {
        URPNowPlaying = item.idContent;
    }
    var fullPath = path.isAbsolute(item.file) ? item.file : path.resolve(contentBasePath, item.file);

    // Si el archivo no existe o es demasiado pequeño/corrupto, saltar de inmediato al siguiente
    if (!fs.existsSync(fullPath)) {
        console.warn("[PLAYER] Archivo no encontrado: " + fullPath + ". Saltando...");
        currentMediaIndex++;
        return setTimeout(playCurrentIndex, 300);
    }
    try {
        var fSize = fs.statSync(fullPath).size;
        var minSize = isVideoFile(fullPath) ? 4096 : 1;
        if (fSize < minSize) {
            console.warn("[PLAYER] Archivo vacío o corrupto (" + fSize + " bytes): " + fullPath + ". Saltando...");
            if (/_\d+s\.mp4$/i.test(fullPath) || fullPath.indexOf(seamlessBasePath) === 0 || fullPath.indexOf(optimizedBasePath) === 0) {
                try { fs.unlinkSync(fullPath); } catch (ue) {}
            }
            currentMediaIndex++;
            return setTimeout(playCurrentIndex, 300);
        }
    } catch (e) {
        currentMediaIndex++;
        return setTimeout(playCurrentIndex, 300);
    }

    var ext = path.extname(fullPath).toLowerCase();
    var isImage = (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.bmp');

    var env = getGuiEnv();
    var mpvRotateDeg = getMpvVideoRotateDeg();

    var token = ++playbackToken;

    if (imageTimer) {
        clearTimeout(imageTimer);
        imageTimer = null;
    }

    // Cerrar cualquier proceso previo de video o imagen de forma SINCRONA antes de lanzar el nuevo
    var needsSyncKill = (activePlayerProcess != null);
    if (activePlayerProcess != null) {
        try {
            activePlayerProcess.removeAllListeners('exit');
            activePlayerProcess.removeAllListeners('error');
            activePlayerProcess.kill('SIGKILL');
        } catch (e) {}
        activePlayerProcess = null;
    }
    if (activeFehProcess != null) {
        try {
            activeFehProcess.removeAllListeners('exit');
            activeFehProcess.removeAllListeners('error');
            activeFehProcess.kill('SIGKILL');
        } catch (e) {}
        activeFehProcess = null;
    }
    if (needsSyncKill) {
        killMediaPlayersSync();
    }

    // --------------------------------------------------------------------------
    // CASO A: IMAGEN (respaldo mpv/feh mientras se convierte a MP4)
    // --------------------------------------------------------------------------
    if (isImage) {
        var duration = (item.duration && item.duration > 0) ? parseInt(item.duration, 10) : 10;
        if (isNaN(duration) || duration <= 0) duration = 10;
        console.log("[PLAYER:IMAGEN] Mostrando (" + duration + "s): " + path.basename(fullPath));

        if (mpvRotateDeg > 0 && hasMpv) {
            try {
                activeFehProcess = spawn('mpv', [
                    '--fs', '--no-osc', '--no-osd-bar', '--really-quiet',
                    '--no-input-default-bindings', '--cursor-autohide=always', '--ontop',
                    '--image-display-duration=inf', '--video-rotate=' + mpvRotateDeg, fullPath
                ], { env: env });
                activeFehProcess.on('error', function () { activeFehProcess = null; });
            } catch (e) {
                activeFehProcess = null;
            }
        } else {
            var fehArgs = ['-F', '-Z', '-x', '-Y', '-B', 'black', '-q', '--hide-pointer', fullPath];
            try {
                activeFehProcess = spawn('feh', fehArgs, { env: env });
                activeFehProcess.on('error', function (err) {
                    console.error("[FEH ERROR]:", err.message);
                    activeFehProcess = null;
                    if (token === playbackToken && isPlaying && hasMpv) {
                        try {
                            activeFehProcess = spawn('mpv', ['--fs', '--no-osc', '--no-osd-bar', '--really-quiet', '--image-display-duration=inf', fullPath], { env: env });
                        } catch (me) {}
                    }
                });
            } catch (e) {
                console.error("[FEH EXCEPTION]", e.message);
                activeFehProcess = null;
            }
        }

        imageTimer = setTimeout(function () {
            imageTimer = null;
            if (token !== playbackToken || !isPlaying) return;
            currentMediaIndex++;
            playCurrentIndex();
        }, duration * 1000);
        return;
    }

    // --------------------------------------------------------------------------
    // CASO B: VIDEO (omxplayer en RPi 3B+ legacy o mpv en RPi 3B+/4/5 Bookworm/Trixie o Video Wall)
    // --------------------------------------------------------------------------
    console.log("[PLAYER:VIDEO] Reproduciendo: " + path.basename(fullPath) + (mpvRotateDeg > 0 ? " [rot=" + mpvRotateDeg + "°]" : ""));

    var wallModeOn = isWallActive();
    var playerBin = (wallModeOn && hasMpv) ? 'mpv' : (hasOmxplayer ? 'omxplayer' : (hasMpv ? 'mpv' : 'omxplayer'));
    var playerArgs = [];

    if (playerBin === 'omxplayer') {
        playerArgs = ['-b', '--no-osd', '--layer', '10000', '--no-keys'];
        if (currentPlaylist.length === 1) {
            playerArgs.push('--loop');
        }
        playerArgs.push(fullPath);
    } else {
        var mpvBaseArgs = [
            '--fs', '--no-osc', '--no-osd-bar', '--really-quiet',
            '--no-input-default-bindings', '--cursor-autohide=always', '--ontop',
            '--hwdec=auto', '--keep-open=no',
            '--scale=bilinear', '--cscale=bilinear', '--dscale=bilinear',
            '--dither-depth=no', '--deband=no',
            '--vd-lavc-fast', '--vd-lavc-skiploopfilter=nonref',
            '--audio-fallback-to-null=yes',
            '--cache=yes', '--demuxer-max-bytes=16M', '--demuxer-max-back-bytes=4M',
            '--framedrop=vo'
        ];
        if (mpvRotateDeg > 0) {
            mpvBaseArgs.push('--video-rotate=' + mpvRotateDeg);
        }
        if (wallModeOn) {
            try { if (fs.existsSync(mpvIpcSocketPath)) fs.unlinkSync(mpvIpcSocketPath); } catch (se) {}
            mpvBaseArgs.push('--input-ipc-server=' + mpvIpcSocketPath);
        }
        var usedMpvPlaylist = false;
        if (currentPlaylist.length > 1 && currentMediaIndex === 0) {
            var mpvPlaylistPaths = [];
            var mpvTelemetryList = [];
            for (var vpIdx = 0; vpIdx < currentPlaylist.length; vpIdx++) {
                var vpItem = currentPlaylist[vpIdx];
                var vpPath = path.isAbsolute(vpItem.file) ? vpItem.file : (contentBasePath + vpItem.file);
                if (isVideoFile(vpPath) && fs.existsSync(vpPath)) {
                    try {
                        if (fs.statSync(vpPath).size > 1024) {
                            mpvPlaylistPaths.push(vpPath);
                            mpvTelemetryList.push({ idContent: vpItem.idContent || 0, duration: vpItem.duration || 10 });
                        }
                    } catch (se) {}
                }
            }
            if (mpvPlaylistPaths.length > 1 && mpvPlaylistPaths.length === currentPlaylist.length) {
                playerArgs = mpvBaseArgs.concat(['--prefetch-playlist=yes', '--loop-playlist=inf'], mpvPlaylistPaths);
                startSeamlessTelemetry(mpvTelemetryList);
                usedMpvPlaylist = true;
                console.log("[PLAYER:MPV] Modo playlist continua en ventana única (" + mpvPlaylistPaths.length + " videos).");
            }
        }
        if (!usedMpvPlaylist) {
            playerArgs = mpvBaseArgs.slice();
            if (currentPlaylist.length === 1) {
                playerArgs.push('--loop-file=inf');
            }
            playerArgs.push(fullPath);
        }
    }

    stopWallSync();
    var playStartTime = Date.now();
    var playerStderr = '';
    try {
        var mediaProc = spawn(playerBin, playerArgs, { env: env, stdio: ['ignore', 'ignore', 'pipe'] });
        activePlayerProcess = mediaProc;
        if (wallModeOn && playerBin === 'mpv' && currentPlaylist.length === 1) {
            startWallSync(fullPath);
        }
        if (mediaProc.stderr) {
            mediaProc.stderr.on('data', function (chunk) {
                playerStderr += chunk.toString('utf8');
                if (playerStderr.length > 1024) playerStderr = playerStderr.slice(-1024);
            });
        }

        mediaProc.on('exit', function (code) {
            if (token !== playbackToken || !isPlaying) return;
            activePlayerProcess = null;
            stopWallSync();
            var elapsed = Date.now() - playStartTime;
            var minExpectedMs = (!item.duration || item.duration >= 3) ? 1000 : 250;
            if (code !== 0 && playerStderr.trim()) {
                console.error("[" + playerBin.toUpperCase() + " EXIT code=" + code + "]: " + playerStderr.trim());
            }
            var isConvertedOrSeamless = (/_\d+s\.mp4$/i.test(fullPath) || fullPath.indexOf(seamlessBasePath) === 0 || fullPath.indexOf(optimizedBasePath) === 0);
            if (isConvertedOrSeamless && (code !== 0 || elapsed < minExpectedMs)) {
                console.error("[PLAYER] Video inválido o fallido (" + path.basename(fullPath) + ", code=" + code + ", " + elapsed + "ms). Eliminando para regenerar...");
                try { fs.unlinkSync(fullPath); } catch (ue) {}
                setTimeout(function () { checkSchedule(); }, 300);
            }
            currentMediaIndex++;
            if (token === playbackToken && isPlaying) {
                setImmediate(playCurrentIndex);
            }
        });

        mediaProc.on('error', function (err) {
            console.error("[" + playerBin.toUpperCase() + " ERROR]:", err.message);
            if (token !== playbackToken || !isPlaying) return;
            activePlayerProcess = null;
            stopWallSync();
            currentMediaIndex++;
            setTimeout(function () {
                if (token === playbackToken && isPlaying) {
                    playCurrentIndex();
                }
            }, 500);
        });
    } catch (e) {
        console.error("[PLAYER EXCEPTION]", e.message);
        if (token !== playbackToken || !isPlaying) return;
        currentMediaIndex++;
        setTimeout(playCurrentIndex, 500);
    }
}

// Despachador principal de listas (acepta archivos o pares { file, duration })
var seamlessTelemetryTimer = null;

function stopSeamlessTelemetry() {
    if (seamlessTelemetryTimer) {
        clearTimeout(seamlessTelemetryTimer);
        seamlessTelemetryTimer = null;
    }
}

function startSeamlessTelemetry(items) {
    stopSeamlessTelemetry();
    if (!Array.isArray(items) || items.length === 0) return;
    var idx = 0;
    var step = function () {
        if (!isPlaying) return;
        var cur = items[idx % items.length];
        if (cur && cur.idContent) {
            URPNowPlaying = cur.idContent;
        }
        var durMs = ((cur && cur.duration > 0) ? parseInt(cur.duration, 10) : 10) * 1000;
        if (isNaN(durMs) || durMs < 1000) durMs = 10000;
        idx = (idx + 1) % items.length;
        seamlessTelemetryTimer = setTimeout(step, durMs);
    };
    step();
}

function playSignagePlaylist(playlist) {
    killBackground();
    if (!playlist || playlist.length === 0) return;

    var newItems = playlist.map(function (item) {
        if (typeof item === 'string') {
            return {
                file: path.isAbsolute(item) ? item : path.basename(item),
                duration: 10
            };
        } else if (item && typeof item === 'object') {
            var rawFile = item.content || item.file || '';
            return {
                file: path.isAbsolute(rawFile) ? rawFile : path.basename(rawFile),
                duration: item.length || item.duration || 10,
                idContent: item.idContent || 0,
                telemetryItems: item.telemetryItems || null
            };
        }
        return null;
    }).filter(function (it) { return it !== null && it.file.length > 0; });

    if (newItems.length === 0) return;

    var fileList = newItems.map(function (it) { return it.file; });

    if (isPlaying && _.isEqual(fileList, filesPlaying) && (activePlayerProcess != null || activeFehProcess != null || imageTimer != null)) {
        return;
    }

    stopSeamlessTelemetry();
    if (newItems.length === 1 && newItems[0].telemetryItems) {
        startSeamlessTelemetry(newItems[0].telemetryItems);
    }

    filesPlaying = fileList;
    currentPlaylist = newItems;
    currentMediaIndex = 0;
    isPlaying = true;

    playCurrentIndex();
}

function stopOmx(callback) {
    isPlaying = false;
    stopSeamlessTelemetry();
    filesPlaying = [];
    currentPlaylist = [];
    stopCurrentMedia(callback);
}

// ==============================================================================
// 3. INICIO INMEDIATO CON VIDEOS DEL DISCO (FALLBACK OFFLINE)
// ==============================================================================
function emergencyDiskPlayback() {
    try {
        if (isPlaying) return;
        if (!fs.existsSync(contentBasePath)) return;

        var diskFiles = fs.readdirSync(contentBasePath);

        // Disparar conversion automatica de imagenes sueltas en content a video MP4
        convertExistingImages();

        var curWallSig = getWallSignature();
        var videoFiles = diskFiles.filter(function (f) {
            if (!isVideoFile(f) || f.indexOf('.part') !== -1 || f.indexOf('temp_') !== -1) {
                return false;
            }
            if (/_\d+s\.mp4$/i.test(f)) {
                if (isWallTileActive()) {
                    if (f.indexOf('_' + curWallSig + '_') === -1) return false;
                } else {
                    if (/_WT[^_]*_.*_\d+s\.mp4$/i.test(f)) return false;
                }
            }
            try {
                var fullP = path.join(contentBasePath, f);
                var sz = fs.statSync(fullP).size;
                if (sz <= 4096) {
                    if (/_\d+s\.mp4$/i.test(f)) {
                        try { fs.unlinkSync(fullP); } catch (ue) {}
                    }
                    return false;
                }
                return true;
            } catch (e) {
                return false;
            }
        });

        // Si ya hay videos (incluyendo los MP4 generados de imagenes), reproducirlos en bucle (usando copia optimizada si ya existe)
        if (videoFiles.length > 0) {
            var resolvedDiskVideos = [];
            console.log('[STARTUP] ¡' + videoFiles.length + ' video(s) encontrados en disco! Iniciando reproduccion continua:');
            for (var p = 0; p < videoFiles.length; p++) {
                var rawDiskPath = path.join(contentBasePath, videoFiles[p]);
                var optDiskPath = getOptimizedVideoPath(rawDiskPath);
                if (optDiskPath && fs.existsSync(optDiskPath)) {
                    try {
                        if (fs.statSync(optDiskPath).size > 4096) {
                            resolvedDiskVideos.push(optDiskPath);
                            console.log('  -> ' + videoFiles[p] + ' (optimizado)');
                            continue;
                        }
                    } catch (oe) {}
                }
                if (!/_\d+s\.mp4$/i.test(videoFiles[p])) {
                    scheduleVideoOptimization(rawDiskPath);
                }
                resolvedDiskVideos.push(videoFiles[p]);
                console.log('  -> ' + videoFiles[p]);
            }
            playSignagePlaylist(resolvedDiskVideos);
            return;
        }

        var imageFiles = diskFiles.filter(function (f) {
            return isImg(f) && f.indexOf('.part') === -1 && f.indexOf('temp_') === -1;
        });

        if (imageFiles.length > 0) {
            playSignagePlaylist(imageFiles);
        } else {
            console.log('[STARTUP] No hay medios en ' + contentBasePath + '. Esperando contenido...');
            setBackground();
        }
    } catch (e) {
        console.error('[STARTUP] Error en emergencyDiskPlayback:', e.message);
    }
}

// Directorios iniciales
function ensureDir(p) {
    try {
        if (!fs.existsSync(p)) {
            var parent = path.dirname(p);
            if (parent && parent !== p && !fs.existsSync(parent)) ensureDir(parent);
            fs.mkdirSync(p);
        }
    } catch (e) {}
}
ensureDir(basePath);
ensureDir(contentBasePath);
ensureDir(tempFolderPath);
ensureDir(seamlessBasePath);
ensureDir(optimizedBasePath);

// Ejecutar reproduccion de disco inmediatamente al arrancar el script
emergencyDiskPlayback();

// ==============================================================================
// 4. BASE DE DATOS LEVELDB ROBUSTA (Compatible level v6/v7, v8/v9/v10 y fallback JSON)
// ==============================================================================
var level = null;
var db = null;

function createJsonDbAdapter(jsonPath) {
    function readStore() {
        try {
            if (fs.existsSync(jsonPath)) {
                return JSON.parse(fs.readFileSync(jsonPath, 'utf8') || '{}');
            }
        } catch (e) {}
        return {};
    }
    function writeStore(obj) {
        try {
            var tmp = jsonPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(obj));
            fs.renameSync(tmp, jsonPath);
        } catch (e) {}
    }
    return {
        get: function (key, cb) {
            var store = readStore();
            if (Object.prototype.hasOwnProperty.call(store, key)) {
                if (typeof cb === 'function') cb(null, store[key]);
            } else {
                if (typeof cb === 'function') cb(new Error('Key not found: ' + key));
            }
        },
        put: function (key, val, cb) {
            var store = readStore();
            store[key] = val;
            writeStore(store);
            if (typeof cb === 'function') cb(null);
        },
        del: function (key, cb) {
            var store = readStore();
            delete store[key];
            writeStore(store);
            if (typeof cb === 'function') cb(null);
        }
    };
}

function wrapModernLevel(rawDb, jsonBackup) {
    return {
        get: function (key, cb) {
            try {
                var res = rawDb.get(key);
                if (res && typeof res.then === 'function') {
                    res.then(function (val) {
                        if (typeof cb === 'function') cb(null, val);
                    }, function (err) {
                        jsonBackup.get(key, function (jErr, jVal) {
                            if (!jErr && jVal !== undefined) {
                                if (typeof cb === 'function') cb(null, jVal);
                            } else {
                                if (typeof cb === 'function') cb(err || jErr);
                            }
                        });
                    });
                } else {
                    rawDb.get(key, cb);
                }
            } catch (e) {
                jsonBackup.get(key, cb);
            }
        },
        put: function (key, val, cb) {
            jsonBackup.put(key, val);
            try {
                var res = rawDb.put(key, val);
                if (res && typeof res.then === 'function') {
                    res.then(function () { if (typeof cb === 'function') cb(null); }, function (e) { if (typeof cb === 'function') cb(e); });
                }
            } catch (e) {
                if (typeof cb === 'function') cb(e);
            }
        },
        del: function (key, cb) {
            jsonBackup.del(key);
            try {
                var res = rawDb.del(key);
                if (res && typeof res.then === 'function') {
                    res.then(function () { if (typeof cb === 'function') cb(null); }, function (e) { if (typeof cb === 'function') cb(e); });
                }
            } catch (e) {
                if (typeof cb === 'function') cb(e);
            }
        }
    };
}

var jsonFallbackDb = createJsonDbAdapter(basePath + 'URPDB.json');
try {
    // Si hubo un corte de luz o crash previo, limpiar lock huerfano para no congelar
    var lockFile = basePath + 'URPDB/LOCK';
    if (fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch (e) {}
    }
    level = require('level');
    if (typeof level === 'function') {
        var legacyDb = level(basePath + 'URPDB');
        db = {
            get: function (k, cb) {
                legacyDb.get(k, function (err, val) {
                    if (!err && val !== undefined) return cb && cb(null, val);
                    jsonFallbackDb.get(k, cb);
                });
            },
            put: function (k, v, cb) { jsonFallbackDb.put(k, v); legacyDb.put(k, v, cb); },
            del: function (k, cb) { jsonFallbackDb.del(k); legacyDb.del(k, cb); }
        };
    } else if (level && typeof level.Level === 'function') {
        db = wrapModernLevel(new level.Level(basePath + 'URPDB'), jsonFallbackDb);
    } else {
        db = jsonFallbackDb;
    }
} catch (e) {
    console.warn('[DB] LevelDB no disponible o bloqueada, usando almacenamiento JSON:', e.message);
    db = jsonFallbackDb;
}

function initDB() {
    if (!db) return;
    db.get('URPData', function (err, val) {
        if (!err && val) {
            try {
                var prevWall = isWallActive();
                var saved = JSON.parse(val);
                var currentIp = URPdata.URPIpAddress;
                URPdata = Object.assign({}, saved, URPdata);
                if (currentIp) URPdata.URPIpAddress = currentIp;
                if (prevWall !== isWallActive() && Array.isArray(schedule) && schedule.length > 0) {
                    setTimeout(function () { checkSchedule(); }, 300);
                }
            } catch (e) {}
        }
    });
    db.get('schedule', function (err, val) {
        if (!err && val) {
            try {
                var parsed = JSON.parse(val);
                if (Array.isArray(parsed)) {
                    schedule = parsed;
                } else if (typeof parsed === 'object' && parsed !== null) {
                    schedule = Object.keys(parsed).map(function (k) { return parsed[k]; });
                }
                playOmx();
            } catch (e) {}
        }
    });
    db.get('contents', function (err, val) {
        if (!err && val) {
            try {
                contents = JSON.parse(val);
                max = contents.length;
            } catch (e) {}
        }
    });
}
initDB();

// ==============================================================================
// 5. UTILIDADES DE ARCHIVOS Y RED
// ==============================================================================
var d = require('domain').create();
d.on('error', function (err) {
    var date = new Date();
    if (err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'))
        console.error(convertDate(date) + " connection timeout: " + err.message);
    else
        console.error(convertDate(date) + " domain error caught:", err ? err.message : err);
});

var request = require('request');
var async = require('async');
var JSFtp = require('jsftp');
var url = require('url');
var http = require('http');
var crypto = require('crypto');
var algorithm = 'aes-256-ctr';
var password = 'TBEE';

function evpBytesToKey(passStr, keyLen, ivLen) {
    var passBuf = Buffer.from(String(passStr), 'utf8');
    var chunks = [];
    var totalLen = 0;
    var prev = Buffer.alloc(0);
    while (totalLen < keyLen + ivLen) {
        var md5 = crypto.createHash('md5');
        md5.update(prev);
        md5.update(passBuf);
        prev = md5.digest();
        chunks.push(prev);
        totalLen += prev.length;
    }
    var derived = Buffer.concat(chunks);
    return {
        key: derived.slice(0, keyLen),
        iv: derived.slice(keyLen, keyLen + ivLen)
    };
}

function decrypt(text) {
    if (!text) return '';
    try {
        var decipher;
        if (typeof crypto.createDecipher === 'function') {
            decipher = crypto.createDecipher(algorithm, password);
        } else {
            var k = evpBytesToKey(password, 32, 16);
            decipher = crypto.createDecipheriv(algorithm, k.key, k.iv);
        }
        var dec = decipher.update(text, 'hex', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    } catch (err) {
        return text;
    }
}

function convertDate(d) {
    function pad(s) { return (s < 10) ? '0' + s : s; }
    return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join('-');
}

var md5Cache = {};
function getFileMD5(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        var st = fs.statSync(filePath);
        var cached = md5Cache[filePath];
        if (cached && cached.size === st.size && cached.mtime === st.mtime.getTime()) {
            return cached.md5;
        }
        var hash = crypto.createHash('md5');
        var fd = fs.openSync(filePath, 'r');
        var buf = Buffer.alloc(1024 * 1024);
        var bytesRead = 0;
        try {
            while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
                hash.update(bytesRead === buf.length ? buf : buf.slice(0, bytesRead));
            }
        } finally {
            fs.closeSync(fd);
        }
        var digest = hash.digest('hex').toLowerCase();
        md5Cache[filePath] = { size: st.size, mtime: st.mtime.getTime(), md5: digest };
        return digest;
    } catch (e) {
        return null;
    }
}

function normalizeName(filename) {
    if (!filename) return '';
    return filename.trim().replace(/\s+/g, '_');
}

function buildFtpPath(base, customerId, filename) {
    var cleanBase = (base || '').trim();
    if (cleanBase.length > 0 && cleanBase.charAt(cleanBase.length - 1) !== '/') {
        cleanBase += '/';
    }
    return cleanBase + (customerId || '') + '/' + filename;
}

function fileExist(filePath) {
    try {
        return fs.existsSync(filePath);
    } catch (e) {
        return false;
    }
}

function isImg(filename) {
    if (!filename) return false;
    var ext = filename.split('.').pop().toLowerCase();
    return ['png', 'jpg', 'jpeg'].indexOf(ext) !== -1;
}

function isVideoFile(filename) {
    if (!filename) return false;
    var ext = path.extname(filename).toLowerCase();
    return ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts', '.mpg', '.mpeg', '.wmv', '.flv'].indexOf(ext) !== -1;
}

// Cola secuencial atómica para conversión de imagen a video MP4 (compatible VideoCore IV / MPV)
var renderQueue = [];
var activeRenderOutPath = '';
var activeRenderCallbacks = [];

function processNextRender() {
    if (isRendering || renderQueue.length === 0) return;
    if (!bootGraceDone) {
        setTimeout(processNextRender, 3000);
        return;
    }

    var job = renderQueue.shift();
    isRendering = true;
    activeRenderOutPath = job.outPath;
    activeRenderCallbacks = job.callbacks || [];

    var file = job.file;
    var duration = job.duration;
    var outPath = job.outPath;
    var tmpPath = contentBasePath + 'temp_' + Date.now() + '_' + path.basename(outPath);

    var finishJob = function (success) {
        isRendering = false;
        activeRenderOutPath = '';
        var cbs = activeRenderCallbacks.slice();
        activeRenderCallbacks = [];

        if (!success && fileExist(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
        }

        for (var ci = 0; ci < cbs.length; ci++) {
            try { cbs[ci](success); } catch (e) {}
        }

        if (success) {
            setTimeout(function () {
                checkSchedule();
            }, 500);
        }
        processNextRender();
    };

    if (!fileExist(file)) {
        console.warn('[RENDER] Imagen origen no encontrada: ' + file);
        return finishJob(false);
    }

    if (fileExist(outPath)) {
        try {
            if (fs.statSync(outPath).size > 4096) {
                return finishJob(true);
            } else {
                fs.unlinkSync(outPath);
            }
        } catch (e) {}
    }

    if (fileExist(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
    }

    var dims = getTargetVideoDims();
    var targetW = dims.width;
    var targetH = dims.height;
    var wallCrop = isWallTileActive() ? (getWallCropFilter() + ',') : '';
    var vf = wallCrop +
             'scale=' + targetW + ':' + targetH + ':force_original_aspect_ratio=decrease,' +
             'scale=trunc(iw/2)*2:trunc(ih/2)*2,' +
             'pad=' + targetW + ':' + targetH + ':(' + targetW + '-iw)/2:(' + targetH + '-ih)/2:black,' +
             'setsar=1,format=yuv420p';

    var ffArgs = [
        '-nostdin',
        '-y',
        '-loglevel', 'error',
        '-loop', '1',
        '-framerate', '25',
        '-t', String(duration),
        '-i', file,
        '-f', 'lavfi',
        '-t', String(duration),
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-vf', vf,
        '-c:v', 'libx264',
        '-threads', dims.threads,
        '-preset', 'ultrafast',
        '-profile:v', dims.profile,
        '-level', dims.level,
        '-pix_fmt', 'yuv420p',
        '-r', '25',
        '-g', '25',
        '-bf', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-t', String(duration),
        '-movflags', '+faststart',
        tmpPath
    ];

    console.log('[RENDER] Convirtiendo imagen a video MP4 (' + duration + 's, ' + targetW + 'x' + targetH + '): ' + path.basename(file) + ' -> ' + path.basename(outPath));

    var stderrLog = '';
    var ffProc = null;
    var finished = false;

    var renderTimeout = setTimeout(function () {
        if (!finished) {
            finished = true;
            console.error('[RENDER] Timeout convirtiendo imagen (>120s): ' + path.basename(file));
            try { if (ffProc) ffProc.kill('SIGKILL'); } catch (e) {}
            finishJob(false);
        }
    }, 120000);

    try {
        ffProc = spawnFfmpegLowPriority(ffArgs);
        if (ffProc.stderr) {
            ffProc.stderr.on('data', function (chunk) {
                stderrLog += chunk.toString('utf8');
                if (stderrLog.length > 2048) {
                    stderrLog = stderrLog.slice(-2048);
                }
            });
        }
        ffProc.on('error', function (err) {
            if (finished) return;
            finished = true;
            clearTimeout(renderTimeout);
            console.error('[RENDER] No se pudo iniciar ffmpeg:', err.message);
            finishJob(false);
        });
        ffProc.on('close', function (code) {
            if (finished) return;
            finished = true;
            clearTimeout(renderTimeout);

            if (code !== 0) {
                console.error('[RENDER] Error ffmpeg (code ' + code + '): ' + (stderrLog.trim() || 'sin detalle'));
                return finishJob(false);
            }

            try {
                if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size <= 4096) {
                    console.error('[RENDER] Archivo MP4 generado vacío o corrupto: ' + tmpPath);
                    return finishJob(false);
                }
                if (fs.existsSync(outPath)) {
                    try { fs.unlinkSync(outPath); } catch (e) {}
                }
                fs.renameSync(tmpPath, outPath);
                var finalSize = fs.statSync(outPath).size;
                console.log('[RENDER] ¡Video MP4 generado exitosamente!: ' + outPath + ' (' + finalSize + ' bytes)');
                return finishJob(true);
            } catch (err) {
                console.error('[RENDER] Error finalizando MP4:', err.message);
                return finishJob(false);
            }
        });
    } catch (e) {
        if (!finished) {
            finished = true;
            clearTimeout(renderTimeout);
            console.error('[RENDER] Excepción iniciando ffmpeg:', e.message);
            finishJob(false);
        }
    }
}

function imgToVideo(file, name, time, callback) {
    var duration = parseInt(time, 10);
    if (isNaN(duration) || duration <= 0) duration = 10;
    var safeName = normalizeName(name);
    var outPath = contentBasePath + safeName + '.mp4';

    if (fileExist(outPath)) {
        try {
            if (fs.statSync(outPath).size > 4096) {
                if (typeof callback === 'function') callback(true);
                return;
            } else {
                fs.unlinkSync(outPath);
            }
        } catch (e) {}
    }

    if (isRendering && activeRenderOutPath === outPath) {
        if (typeof callback === 'function') activeRenderCallbacks.push(callback);
        return;
    }

    for (var qi = 0; qi < renderQueue.length; qi++) {
        if (renderQueue[qi].outPath === outPath) {
            if (typeof callback === 'function') renderQueue[qi].callbacks.push(callback);
            return;
        }
    }

    renderQueue.push({
        file: file,
        duration: duration,
        outPath: outPath,
        callbacks: (typeof callback === 'function') ? [callback] : []
    });
    processNextRender();
}

function convertExistingImages(callback) {
    if (!fs.existsSync(contentBasePath)) {
        if (callback) callback();
        return;
    }
    try {
        var files = fs.readdirSync(contentBasePath);
        var images = files.filter(function (f) {
            return isImg(f) && f.indexOf('.part') === -1 && f.indexOf('temp_') === -1;
        });
        if (images.length === 0) {
            if (callback) callback();
            return;
        }
        console.log('[CONVERT] Verificando ' + images.length + ' imagen(es) para conversión a video MP4...');
        async.eachSeries(images, function (imgFile, next) {
            var baseNoExt = normalizeName(imgFile).replace(/\.[^/.]+$/, "");
            var defaultDuration = 10;

            var scheduleArr = Array.isArray(schedule) ? schedule : [];
            for (var b = 0; b < scheduleArr.length; b++) {
                var blkContents = scheduleArr[b].contents || [];
                for (var c = 0; c < blkContents.length; c++) {
                    if (blkContents[c].content === imgFile || normalizeName(blkContents[c].content) === normalizeName(imgFile)) {
                        var parsedLen = parseInt(blkContents[c].length, 10);
                        if (!isNaN(parsedLen) && parsedLen > 0) {
                            defaultDuration = parsedLen;
                        }
                    }
                }
            }

            var wallTag = isWallTileActive() ? ('_' + getWallSignature()) : '';
            var expectedVideo = contentBasePath + baseNoExt + wallTag + '_' + defaultDuration + 's.mp4';
            if (fileExist(expectedVideo)) {
                try {
                    if (fs.statSync(expectedVideo).size > 4096) return next();
                    fs.unlinkSync(expectedVideo);
                } catch (e) {}
            }
            imgToVideo(contentBasePath + imgFile, baseNoExt + wallTag + '_' + defaultDuration + 's', defaultDuration, function () {
                next();
            });
        }, function () {
            if (callback) callback();
        });
    } catch (e) {
        if (callback) callback();
    }
}

// ==============================================================================
// 5B. OPTIMIZACION AUTOMATICA DE VIDEOS PESADOS PARA RASPBERRY PI (NO BLOQUEANTE)
// ==============================================================================
var videoOptQueue = [];
var isOptimizingVideo = false;
var activeVideoOptOutPath = '';
var noOptNeededMap = {};
var failedOptMap = {};

function getOptimizedVideoPath(srcPath) {
    try {
        if (!srcPath || !fs.existsSync(srcPath)) return null;
        var st = fs.statSync(srcPath);
        var ori = isPortraitOrientation() ? 'V' : 'H';
        var dims = getTargetVideoDims();
        var wallSig = getWallSignature();
        var wallSuffix = wallSig ? ('_' + wallSig) : '';
        var baseName = path.basename(srcPath).replace(/\.[^/.]+$/, '');
        var safeBase = normalizeName(baseName).replace(/[^a-zA-Z0-9._-]/g, '_');
        return optimizedBasePath + 'opt_' + safeBase + '_' + st.size + '_' + st.mtime.getTime() + '_' + ori + '_' + dims.width + 'x' + dims.height + wallSuffix + '_p2.mp4';
    } catch (e) {
        return null;
    }
}

function cleanupOldOptimizedForBase(safeBasePrefix, keepFileName) {
    try {
        if (!fs.existsSync(optimizedBasePath)) return;
        var files = fs.readdirSync(optimizedBasePath);
        for (var i = 0; i < files.length; i++) {
            if (files[i].indexOf(safeBasePrefix) === 0 && files[i] !== keepFileName && files[i].indexOf('temp_') !== 0) {
                try { fs.unlinkSync(path.join(optimizedBasePath, files[i])); } catch (e) {}
            }
        }
    } catch (e) {}
}

function needsPiVideoOptimization(info) {
    if (!info || !info.hasVideo) return { needed: false, reason: 'no_video' };
    if (isWallTileActive()) {
        return { needed: true, reason: 'videowall_tile_' + wallConfig.rows + 'x' + wallConfig.cols + '_f' + (wallConfig.row + 1) + 'c' + (wallConfig.col + 1) };
    }
    var ext = path.extname(info.fullPath).toLowerCase();
    if (ext !== '.mp4') return { needed: true, reason: 'contenedor ' + ext };
    if (info.videoCodec && info.videoCodec !== 'h264') return { needed: true, reason: 'codec ' + info.videoCodec };
    if (info.pixFmt && info.pixFmt !== 'yuv420p' && info.pixFmt !== 'yuvj420p') return { needed: true, reason: 'pix_fmt ' + info.pixFmt };
    if (info.profile && /(10|422|444)/i.test(info.profile)) return { needed: true, reason: 'profile ' + info.profile };

    var dims = getTargetVideoDims();
    var w = info.width || 0;
    var h = info.height || 0;
    var maxDim = Math.max(w, h);
    var minDim = Math.min(w, h);
    var limitLong = dims.use720p ? 1280 : 1920;
    var limitShort = dims.use720p ? 720 : 1080;
    var maxFps = 26;
    var maxBps = dims.use720p ? 3200000 : 6000000;

    if (dims.use720p && info.profile && /high/i.test(info.profile)) {
        return { needed: true, reason: 'perfil ' + info.profile + ' pesado para 3B+' };
    }
    if (maxDim > limitLong || minDim > limitShort) return { needed: true, reason: 'resolucion ' + w + 'x' + h + ' -> ' + limitLong + 'p' };
    if (info.fps && info.fps > maxFps) return { needed: true, reason: info.fps.toFixed(1) + 'fps' };
    if (info.bitRate && info.bitRate > maxBps) return { needed: true, reason: (info.bitRate / 1000000).toFixed(1) + 'Mbps' };
    if (info.hasAudio && info.audioCodec && info.audioCodec !== 'aac' && info.audioCodec !== 'mp3') {
        return { needed: true, reason: 'audio ' + info.audioCodec };
    }
    return { needed: false, reason: 'compatible' };
}

function processNextVideoOpt() {
    if (isOptimizingVideo || videoOptQueue.length === 0) return;
    if (!bootGraceDone || isRendering || isConcatenating) {
        setTimeout(processNextVideoOpt, 3000);
        return;
    }

    var job = videoOptQueue.shift();
    var srcPath = job.srcPath;
    var outPath = job.outPath;

    if (!fs.existsSync(srcPath) || failedOptMap[outPath]) {
        return processNextVideoOpt();
    }
    if (fs.existsSync(outPath)) {
        try {
            if (fs.statSync(outPath).size > 4096) return processNextVideoOpt();
            fs.unlinkSync(outPath);
        } catch (e) {}
    }

    isOptimizingVideo = true;
    activeVideoOptOutPath = outPath;

    probeMediaFile(srcPath, function (info) {
        if (!info || !info.hasVideo) {
            isOptimizingVideo = false;
            activeVideoOptOutPath = '';
            return processNextVideoOpt();
        }

        var check = needsPiVideoOptimization(info);
        if (!check.needed) {
            try {
                var stOk = fs.statSync(srcPath);
                noOptNeededMap[srcPath] = stOk.size + ':' + stOk.mtime.getTime();
            } catch (e) {}
            isOptimizingVideo = false;
            activeVideoOptOutPath = '';
            return processNextVideoOpt();
        }

        ensureDir(optimizedBasePath);
        var dims = getTargetVideoDims();
        var maxW = dims.width;
        var maxH = dims.height;
        var targetFps = (info.fps && info.fps > 0 && info.fps <= 25) ? Math.max(15, Math.round(info.fps)) : 25;
        var tileMode = isWallTileActive();
        var wallCrop = tileMode ? (getWallCropFilter() + ',') : '';
        var tilePad = tileMode ? ('pad=' + maxW + ':' + maxH + ':(' + maxW + '-iw)/2:(' + maxH + '-ih)/2:black,') : '';
        var vf = wallCrop +
                 'scale=' + maxW + ':' + maxH + ':force_original_aspect_ratio=decrease,' +
                 'scale=trunc(iw/2)*2:trunc(ih/2)*2,' + tilePad + 'setsar=1,format=yuv420p';

        var tmpPath = optimizedBasePath + 'temp_' + Date.now() + '_' + path.basename(outPath);
        if (fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
        }

        var ffArgs = [
            '-nostdin', '-y', '-loglevel', 'error',
            '-i', srcPath,
            '-vf', vf,
            '-c:v', 'libx264',
            '-threads', dims.threads,
            '-preset', 'veryfast',
            '-profile:v', dims.profile,
            '-level', dims.level,
            '-pix_fmt', 'yuv420p',
            '-r', String(targetFps),
            '-g', String(targetFps),
            '-bf', '0',
            '-crf', dims.crf,
            '-maxrate', dims.maxRate,
            '-bufsize', dims.bufSize
        ];
        if (info.hasAudio) {
            ffArgs.push('-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k');
        } else {
            ffArgs.push('-an');
        }
        ffArgs.push('-movflags', '+faststart', tmpPath);

        console.log('[OPT:VIDEO] Normalizando video en segundo plano (' + check.reason + '): ' + path.basename(srcPath));

        var finished = false;
        var ffProc = null;
        var stderrLog = '';

        var finishOpt = function (ok) {
            if (finished) return;
            finished = true;
            isOptimizingVideo = false;
            activeVideoOptOutPath = '';
            if (!ok && fs.existsSync(tmpPath)) {
                try { fs.unlinkSync(tmpPath); } catch (e) {}
            }
            if (ok) {
                setTimeout(function () { checkSchedule(); }, 400);
            }
            setTimeout(processNextVideoOpt, 300);
        };

        var optTimeout = setTimeout(function () {
            if (!finished) {
                console.error('[OPT:VIDEO] Timeout normalizando ' + path.basename(srcPath));
                try { if (ffProc) ffProc.kill('SIGKILL'); } catch (e) {}
                failedOptMap[outPath] = true;
                finishOpt(false);
            }
        }, 1800000);

        try {
            ffProc = spawnFfmpegLowPriority(ffArgs);
            if (ffProc.stderr) {
                ffProc.stderr.on('data', function (chunk) {
                    stderrLog += chunk.toString('utf8');
                    if (stderrLog.length > 2048) stderrLog = stderrLog.slice(-2048);
                });
            }
            ffProc.on('error', function (err) {
                clearTimeout(optTimeout);
                console.error('[OPT:VIDEO] Error iniciando ffmpeg:', err.message);
                failedOptMap[outPath] = true;
                finishOpt(false);
            });
            ffProc.on('close', function (code) {
                clearTimeout(optTimeout);
                if (code !== 0 || !fs.existsSync(tmpPath) || fs.statSync(tmpPath).size <= 4096) {
                    console.error('[OPT:VIDEO] Falló conversión (' + path.basename(srcPath) + ', code=' + code + '): ' + (stderrLog.trim() || 'sin detalle'));
                    failedOptMap[outPath] = true;
                    return finishOpt(false);
                }
                try {
                    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
                    fs.renameSync(tmpPath, outPath);
                    var basePrefix = 'opt_' + normalizeName(path.basename(srcPath).replace(/\.[^/.]+$/, '')).replace(/[^a-zA-Z0-9._-]/g, '_') + '_';
                    cleanupOldOptimizedForBase(basePrefix, path.basename(outPath));
                    console.log('[OPT:VIDEO] ¡Video fluido listo!: ' + path.basename(outPath) + ' (' + (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2) + ' MB)');
                    return finishOpt(true);
                } catch (e) {
                    failedOptMap[outPath] = true;
                    return finishOpt(false);
                }
            });
        } catch (e) {
            clearTimeout(optTimeout);
            failedOptMap[outPath] = true;
            finishOpt(false);
        }
    });
}

function scheduleVideoOptimization(srcPath) {
    if (!isArm && !isLinux) return;
    if (!srcPath || !fs.existsSync(srcPath)) return;
    if (!isVideoFile(srcPath) || /_\d+s\.mp4$/i.test(srcPath)) return;
    if (srcPath.indexOf(optimizedBasePath) === 0 || srcPath.indexOf(seamlessBasePath) === 0) return;

    try {
        var st = fs.statSync(srcPath);
        if (st.size <= 4096) return;
        if (noOptNeededMap[srcPath] === (st.size + ':' + st.mtime.getTime())) return;
    } catch (e) {
        return;
    }

    var outPath = getOptimizedVideoPath(srcPath);
    if (!outPath || failedOptMap[outPath]) return;

    if (fs.existsSync(outPath)) {
        try {
            if (fs.statSync(outPath).size > 4096) return;
            fs.unlinkSync(outPath);
        } catch (e) {}
    }

    if (isOptimizingVideo && activeVideoOptOutPath === outPath) return;
    for (var qi = 0; qi < videoOptQueue.length; qi++) {
        if (videoOptQueue[qi].outPath === outPath) return;
    }

    videoOptQueue.push({ srcPath: srcPath, outPath: outPath });
    processNextVideoOpt();
}

function fileSerch(contentToSearch, nameToSearch, timeToSearch) {
    var safeContent = normalizeName(contentToSearch);
    var safeName = normalizeName(nameToSearch);
    var duration = parseInt(timeToSearch, 10);
    if (isNaN(duration) || duration <= 0) duration = 10;

    // Si el contenido solicitado es una imagen, buscar y preferir su video MP4 convertido
    if (isImg(safeContent) || isImg(contentToSearch)) {
        var baseNoExt = safeContent.replace(/\.[^/.]+$/, "");
        var wallTagImg = isWallTileActive() ? ('_' + getWallSignature()) : '';
        var videoBase = baseNoExt + wallTagImg + '_' + duration + 's';
        var videoName = videoBase + '.mp4';
        var videoPath = contentBasePath + videoName;

        if (fileExist(videoPath)) {
            try {
                if (fs.statSync(videoPath).size > 4096) {
                    return videoName;
                } else {
                    fs.unlinkSync(videoPath);
                }
            } catch (e) {}
        }

        // Si el MP4 aún no existe pero la imagen sí, iniciar conversión asíncrona inmediata
        var imgSource = fileExist(contentBasePath + safeContent) ? (contentBasePath + safeContent) :
                        (fileExist(contentBasePath + contentToSearch) ? (contentBasePath + contentToSearch) : null);

        if (imgSource) {
            imgToVideo(imgSource, videoBase, duration);
            return path.basename(imgSource);
        } else {
            if (!ftpWorking && respuesta) {
                checkContentsFTP();
            }
            return false;
        }
    }

    var targetPath = contentBasePath + safeContent;
    var fileName = safeContent;

    if (!fileExist(targetPath)) {
        if (fileExist(contentBasePath + contentToSearch)) {
            targetPath = contentBasePath + contentToSearch;
            fileName = contentToSearch;
        } else {
            if (!ftpWorking && respuesta) {
                checkContentsFTP();
            }
            return false;
        }
    }

    // Preferir versión optimizada para Raspberry Pi si ya fue generada; sino encolar en segundo plano sin bloquear reproducción
    if (isVideoFile(targetPath) && (isArm || isLinux)) {
        var optPath = getOptimizedVideoPath(targetPath);
        if (optPath && fileExist(optPath)) {
            try {
                if (fs.statSync(optPath).size > 4096) {
                    return optPath;
                } else {
                    fs.unlinkSync(optPath);
                }
            } catch (e) {}
        }
        scheduleVideoOptimization(targetPath);
    }

    return fileName;
}

// ==============================================================================
// 6. GESTION DE HORARIOS Y REPRODUCCION CONTINUA SIN CORTES (SEAMLESS LOOP)
// ==============================================================================
var activeSeamlessHash = '';
var failedSeamlessHashes = {};

function computeBlockHash(items) {
    var dims = getTargetVideoDims();
    var parts = [(isPortraitOrientation() ? 'V' : 'H') + '_' + dims.width + 'x' + dims.height + '_' + getWallSignature()];
    for (var i = 0; i < items.length; i++) {
        var fp = path.isAbsolute(items[i].file) ? items[i].file : path.resolve(contentBasePath, items[i].file);
        try {
            var st = fs.statSync(fp);
            parts.push(path.basename(fp) + ':' + st.size + ':' + st.mtime.getTime());
        } catch (e) {
            parts.push(path.basename(fp) + ':0:0');
        }
    }
    return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 12);
}

function parseFrameRate(frStr) {
    if (!frStr) return 0;
    var parts = String(frStr).split('/');
    if (parts.length === 2) {
        var num = parseFloat(parts[0]);
        var den = parseFloat(parts[1]);
        if (den > 0 && !isNaN(num)) return num / den;
    }
    var val = parseFloat(frStr);
    return isNaN(val) ? 0 : val;
}

function probeMediaFile(fullPath, cb) {
    var ffprobeBin = 'ffprobe';
    var args = ['-v', 'error', '-show_entries', 'format=duration,bit_rate', '-show_entries', 'stream=codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels', '-of', 'json', fullPath];
    var out = '';
    var done = false;
    try {
        var p = spawn(ffprobeBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        if (p.stdout) {
            p.stdout.on('data', function (d) { out += d.toString('utf8'); });
        }
        p.on('error', function () {
            if (!done) { done = true; cb(null); }
        });
        p.on('close', function (code) {
            if (done) return;
            done = true;
            if (code !== 0 || !out) return cb(null);
            try {
                var parsed = JSON.parse(out);
                var streams = parsed.streams || [];
                var hasVideo = false;
                var hasAudio = false;
                var videoCodec = '';
                var profile = '';
                var pixFmt = '';
                var width = 0;
                var height = 0;
                var fps = 0;
                var audioCodec = '';
                var audioSampleRate = 0;
                var audioChannels = 0;
                for (var si = 0; si < streams.length; si++) {
                    var st = streams[si];
                    if (st.codec_type === 'video' && !hasVideo) {
                        hasVideo = true;
                        videoCodec = (st.codec_name || '').toLowerCase();
                        profile = st.profile || '';
                        pixFmt = (st.pix_fmt || '').toLowerCase();
                        width = parseInt(st.width, 10) || 0;
                        height = parseInt(st.height, 10) || 0;
                        fps = parseFrameRate(st.avg_frame_rate) || parseFrameRate(st.r_frame_rate);
                    }
                    if (st.codec_type === 'audio' && !hasAudio) {
                        hasAudio = true;
                        audioCodec = (st.codec_name || '').toLowerCase();
                        audioSampleRate = parseInt(st.sample_rate, 10) || 0;
                        audioChannels = parseInt(st.channels, 10) || 0;
                    }
                }
                var dur = (parsed.format && parsed.format.duration) ? parseFloat(parsed.format.duration) : 0;
                var bitRate = (parsed.format && parsed.format.bit_rate) ? parseInt(parsed.format.bit_rate, 10) : 0;
                cb({
                    fullPath: fullPath,
                    hasVideo: hasVideo,
                    hasAudio: hasAudio,
                    duration: dur,
                    bitRate: bitRate,
                    videoCodec: videoCodec,
                    profile: profile,
                    pixFmt: pixFmt,
                    width: width,
                    height: height,
                    fps: fps,
                    audioCodec: audioCodec,
                    audioSampleRate: audioSampleRate,
                    audioChannels: audioChannels
                });
            } catch (e) {
                cb(null);
            }
        });
    } catch (e) {
        if (!done) { done = true; cb(null); }
    }
}

function cleanupOldSeamless(idBlock, keepFileName) {
    try {
        if (!fs.existsSync(seamlessBasePath)) return;
        var prefix = 'block_' + idBlock + '_';
        var files = fs.readdirSync(seamlessBasePath);
        for (var i = 0; i < files.length; i++) {
            if (files[i].indexOf(prefix) === 0 && files[i] !== keepFileName && files[i].indexOf('temp_') !== 0) {
                try { fs.unlinkSync(path.join(seamlessBasePath, files[i])); } catch (e) {}
            }
        }
    } catch (e) {}
}

function scheduleSeamlessBuild(idBlock, blockHash, items, outPath) {
    if (!bootGraceDone || isRendering || isConcatenating) return;
    if (failedSeamlessHashes[blockHash]) return;
    if (activeSeamlessHash === blockHash) return;
    if (fileExist(outPath)) {
        try {
            if (fs.statSync(outPath).size > 4096) return;
            fs.unlinkSync(outPath);
        } catch (e) {}
    }

    ensureDir(seamlessBasePath);
    isConcatenating = true;
    activeSeamlessHash = blockHash;

    console.log('[SEAMLESS] Preparando stream único continuo para bloque ' + idBlock + ' (' + items.length + ' elementos)...');

    var resolvedItems = items.map(function (it) {
        return {
            fullPath: path.isAbsolute(it.file) ? it.file : path.resolve(contentBasePath, it.file),
            duration: it.duration || 10
        };
    });

    async.mapSeries(resolvedItems, function (ri, next) {
        if (!fs.existsSync(ri.fullPath)) return next(null, null);
        probeMediaFile(ri.fullPath, function (info) {
            if (!info || !info.hasVideo) return next(null, null);
            if (!info.duration || info.duration <= 0) info.duration = ri.duration;
            next(null, info);
        });
    }, function (err, probed) {
        if (err || !probed || probed.some(function (x) { return x === null; })) {
            console.warn('[SEAMLESS] No se pudo analizar todos los videos del bloque ' + idBlock + '. Se mantiene reproducción estándar.');
            failedSeamlessHashes[blockHash] = true;
            isConcatenating = false;
            activeSeamlessHash = '';
            return;
        }

        var dims = getTargetVideoDims();
        var targetW = dims.width;
        var targetH = dims.height;
        var tmpPath = seamlessBasePath + 'temp_' + Date.now() + '_' + path.basename(outPath);
        var concatListPath = null;
        var ffArgs = [];

        var canFastCopy = probed.every(function (pi) {
            return pi.videoCodec === 'h264' &&
                   (pi.pixFmt === 'yuv420p' || pi.pixFmt === 'yuvj420p') &&
                   pi.width === targetW &&
                   pi.height === targetH &&
                   pi.fps >= 23 && pi.fps <= 26 &&
                   pi.hasAudio &&
                   pi.audioCodec === 'aac' &&
                   pi.audioSampleRate === 44100 &&
                   pi.audioChannels === 2;
        });

        if (canFastCopy) {
            concatListPath = seamlessBasePath + 'concat_' + Date.now() + '_' + idBlock + '.txt';
            var listLines = probed.map(function (pi) {
                return "file '" + pi.fullPath.replace(/'/g, "'\\''") + "'";
            });
            try {
                fs.writeFileSync(concatListPath, listLines.join('\n') + '\n', 'utf8');
                ffArgs = [
                    '-nostdin', '-y', '-loglevel', 'error',
                    '-f', 'concat', '-safe', '0', '-i', concatListPath,
                    '-c', 'copy', '-movflags', '+faststart', tmpPath
                ];
                console.log('[SEAMLESS] Todos los clips ya son uniformes (' + targetW + 'x' + targetH + '). Usando unión instantánea (-c copy)...');
            } catch (le) {
                canFastCopy = false;
                concatListPath = null;
            }
        }

        if (!canFastCopy) {
            ffArgs = ['-nostdin', '-y', '-loglevel', 'error'];
            var filterParts = [];
            var concatInputs = '';
            var nextInputIdx = 0;

            var curWallSig = getWallSignature();
            for (var i = 0; i < probed.length; i++) {
                var pi = probed[i];
                var vIdx = nextInputIdx++;
                ffArgs.push('-i', pi.fullPath);

                var alreadyWallCropped = !isWallTileActive() ||
                    (pi.fullPath.indexOf(optimizedBasePath) === 0) ||
                    (curWallSig && pi.fullPath.indexOf('_' + curWallSig + '_') !== -1);
                var segCrop = alreadyWallCropped ? '' : (getWallCropFilter() + ',');

                filterParts.push(
                    '[' + vIdx + ':v]' + segCrop + 'scale=' + targetW + ':' + targetH + ':force_original_aspect_ratio=decrease,' +
                    'scale=trunc(iw/2)*2:trunc(ih/2)*2,' +
                    'pad=' + targetW + ':' + targetH + ':(' + targetW + '-iw)/2:(' + targetH + '-ih)/2:black,' +
                    'setsar=1,fps=25,format=yuv420p[v' + i + ']'
                );

                if (pi.hasAudio) {
                    filterParts.push(
                        '[' + vIdx + ':a]aresample=44100:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo[a' + i + ']'
                    );
                } else {
                    var aIdx = nextInputIdx++;
                    var durStr = (pi.duration && pi.duration > 0) ? pi.duration.toFixed(3) : '10.000';
                    ffArgs.push('-f', 'lavfi', '-t', durStr, '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
                    filterParts.push('[' + aIdx + ':a]aformat=sample_fmts=fltp:channel_layouts=stereo[a' + i + ']');
                }
                concatInputs += '[v' + i + '][a' + i + ']';
            }

            filterParts.push(concatInputs + 'concat=n=' + probed.length + ':v=1:a=1[outv][outa]');

            ffArgs.push(
                '-filter_complex', filterParts.join(';'),
                '-map', '[outv]',
                '-map', '[outa]',
                '-c:v', 'libx264',
                '-threads', dims.threads,
                '-preset', 'ultrafast',
                '-profile:v', dims.profile,
                '-level', dims.level,
                '-pix_fmt', 'yuv420p',
                '-r', '25',
                '-g', '25',
                '-bf', '0',
                '-crf', dims.crf,
                '-maxrate', dims.maxRate,
                '-bufsize', dims.bufSize,
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart',
                tmpPath
            );
        }

        var stderrLog = '';
        var finished = false;
        var ffProc = null;

        var cleanupListFile = function () {
            if (concatListPath && fs.existsSync(concatListPath)) {
                try { fs.unlinkSync(concatListPath); } catch (e) {}
            }
        };

        var concatTimeout = setTimeout(function () {
            if (!finished) {
                finished = true;
                console.error('[SEAMLESS] Timeout construyendo loop continuo del bloque ' + idBlock);
                try { if (ffProc) ffProc.kill('SIGKILL'); } catch (e) {}
                cleanupListFile();
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
                failedSeamlessHashes[blockHash] = true;
                isConcatenating = false;
                activeSeamlessHash = '';
            }
        }, 1800000);

        try {
            ffProc = spawnFfmpegLowPriority(ffArgs);
            if (ffProc.stderr) {
                ffProc.stderr.on('data', function (chunk) {
                    stderrLog += chunk.toString('utf8');
                    if (stderrLog.length > 2048) stderrLog = stderrLog.slice(-2048);
                });
            }
            ffProc.on('error', function (err) {
                if (finished) return;
                finished = true;
                clearTimeout(concatTimeout);
                cleanupListFile();
                console.error('[SEAMLESS] Error iniciando ffmpeg:', err.message);
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
                failedSeamlessHashes[blockHash] = true;
                isConcatenating = false;
                activeSeamlessHash = '';
            });
            ffProc.on('close', function (code) {
                if (finished) return;
                finished = true;
                clearTimeout(concatTimeout);
                cleanupListFile();
                isConcatenating = false;
                activeSeamlessHash = '';

                if (code !== 0 || !fs.existsSync(tmpPath) || fs.statSync(tmpPath).size <= 4096) {
                    console.error('[SEAMLESS] Error generando loop continuo (code ' + code + '): ' + (stderrLog.trim() || 'sin detalle'));
                    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
                    failedSeamlessHashes[blockHash] = true;
                    return;
                }

                try {
                    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
                    fs.renameSync(tmpPath, outPath);
                    cleanupOldSeamless(idBlock, path.basename(outPath));
                    console.log('[SEAMLESS] ¡Loop continuo 0ms listo!: ' + outPath + ' (' + (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2) + ' MB)');
                    setTimeout(function () { checkSchedule(); }, 300);
                } catch (e) {
                    console.error('[SEAMLESS] Error guardando loop continuo:', e.message);
                    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (ue) {}
                    failedSeamlessHashes[blockHash] = true;
                }
            });
        } catch (e) {
            if (!finished) {
                finished = true;
                clearTimeout(concatTimeout);
                cleanupListFile();
                isConcatenating = false;
                activeSeamlessHash = '';
            }
        }
    });
}

function playContent(idBlock) {
    if (playContentRunning) return;
    playContentRunning = true;

    var scheduleArr = Array.isArray(schedule) ? schedule : [];
    if (scheduleArr.length === 0 && typeof schedule === 'object' && schedule !== null) {
        scheduleArr = Object.keys(schedule).map(function (k) { return schedule[k]; });
    }

    var contentsOMX = [];
    for (var ibc = 0; ibc < scheduleArr.length; ibc++) {
        if (String(scheduleArr[ibc].idScheduleBlock) === String(idBlock)) {
            contentsOMX = scheduleArr[ibc].contents || [];
            break;
        }
    }

    if (contentsOMX.length === 0) {
        playContentRunning = false;
        return;
    }

    var filesToPlay = [];
    for (var c = 0; c < contentsOMX.length; c++) {
        var itm = contentsOMX[c];
        var fileName = fileSerch(itm.content, itm.name, itm.length);
        if (fileName !== false) {
            filesToPlay.push({
                file: path.isAbsolute(fileName) ? fileName : path.basename(fileName),
                duration: itm.length || 10,
                idContent: itm.idContent || 0
            });
        }
    }

    // Si ningun archivo del bloque coincide exactamente pero hay videos en disco, no detener
    if (filesToPlay.length === 0) {
        console.warn('[PLAY] Bloque ' + idBlock + ' no tiene archivos listos aun en disco.');
        emergencyDiskPlayback();
        playContentRunning = false;
        return;
    }

    // Si el bloque tiene 2+ elementos y todos ya son videos (incluidas imágenes convertidas),
    // usar o generar el stream único continuo (cero cortes, cero negro, cero escritorio)
    var effectivePlaylist = filesToPlay;
    var allItemsAreVideos = filesToPlay.length > 1 && filesToPlay.every(function (it) {
        return isVideoFile(it.file);
    });

    if (allItemsAreVideos) {
        var blockHash = computeBlockHash(filesToPlay);
        var seamlessPath = seamlessBasePath + 'block_' + idBlock + '_' + blockHash + '.mp4';
        if (fileExist(seamlessPath)) {
            try {
                if (fs.statSync(seamlessPath).size > 4096) {
                    var totalDur = filesToPlay.reduce(function (acc, it) {
                        return acc + (parseInt(it.duration, 10) || 10);
                    }, 0);
                    effectivePlaylist = [{
                        file: seamlessPath,
                        duration: totalDur,
                        idContent: filesToPlay[0].idContent || 0,
                        telemetryItems: filesToPlay
                    }];
                } else {
                    fs.unlinkSync(seamlessPath);
                }
            } catch (e) {}
        }

        if (effectivePlaylist.length > 1) {
            scheduleSeamlessBuild(idBlock, blockHash, filesToPlay, seamlessPath);
        }
    }

    // Si ya estamos reproduciendo este mismo bloque con la misma lista y el reproductor está activo, no interrumpir
    var newFileList = effectivePlaylist.map(function (it) { return it.file; });
    if (String(blockPlaying) === String(idBlock) && isPlaying && _.isEqual(newFileList, filesPlaying) && (activePlayerProcess != null || activeFehProcess != null || imageTimer != null)) {
        playContentRunning = false;
        return;
    }

    console.log('[PLAY] Transicionando al bloque ' + idBlock, newFileList);
    playSignagePlaylist(effectivePlaylist);
    URPNowPlaying = contentsOMX[0] ? contentsOMX[0].idContent : 0;
    blockPlaying = idBlock;
    playContentRunning = false;
}

function timeToMinutes(h, m) {
    return (parseInt(h, 10) * 60) + parseInt(m, 10);
}

function playOmx() {
    var scheduleArr = Array.isArray(schedule) ? schedule : [];
    if (scheduleArr.length === 0 && typeof schedule === 'object' && schedule !== null) {
        scheduleArr = Object.keys(schedule).map(function (k) { return schedule[k]; });
    }

    var f = new Date();
    var horaActual = timeToMinutes(f.getHours(), f.getMinutes());
    var blockToPlay = undefined;
    var maxSchedule = scheduleArr.length;

    for (var ib = 0; ib < maxSchedule; ib++) {
        var horaBloque = timeToMinutes(scheduleArr[ib].startHour, scheduleArr[ib].startMinute);
        if (horaBloque <= horaActual) {
            if (ib + 1 < maxSchedule) {
                var horaNext = timeToMinutes(scheduleArr[ib + 1].startHour, scheduleArr[ib + 1].startMinute);
                if (horaNext > horaActual) {
                    blockToPlay = scheduleArr[ib].idScheduleBlock;
                    break;
                }
            } else {
                blockToPlay = scheduleArr[ib].idScheduleBlock;
                break;
            }
        }
    }

    // PROTECCION POR DESINCRONIZACION HORARIA:
    // Si la hora de arranque no coincide o el reloj esta desfasado, reproducir el primer bloque disponible
    if (typeof blockToPlay === 'undefined' && maxSchedule > 0) {
        blockToPlay = scheduleArr[0].idScheduleBlock;
        console.log('[SCHEDULE] Usando bloque predeterminado ' + blockToPlay);
    }

    if (typeof blockToPlay !== 'undefined') {
        playContent(blockToPlay);
    } else {
        // Si no hay programacion, reproducir lo que haya en disco antes de parar
        emergencyDiskPlayback();
    }
}

function checkSchedule() {
    loadWallConfig();
    playOmx();
}

function checkTime() {
    var date = new Date();
    var current_hour = date.getHours();
    var current_minutes = date.getMinutes();
    if (URPdata.autoReboot != undefined && URPdata.autoReboot == 1) {
        if (URPdata.autoRebootHour == current_hour && URPdata.autoRebootMinute == current_minutes) {
            if (URPdata.autoRebootDay == 0) {
                resetURP();
                return;
            } else {
                var current_day = date.getDay() + 1;
                if (current_day == URPdata.autoRebootDay) {
                    resetURP();
                    return;
                }
            }
        }
    }
    checkSchedule();
}

var wallScheduleIntervalId = null;
function startWallScheduleWatcher() {
    if (wallScheduleIntervalId != null) clearInterval(wallScheduleIntervalId);
    wallScheduleIntervalId = setInterval(function () {
        if (isWallActive() && Array.isArray(schedule) && schedule.length > 0) {
            checkSchedule();
        }
    }, 5000);
}

function waitToStart() {
    checkTime();
    if (refreshIntervalId != null) clearInterval(refreshIntervalId);
    refreshIntervalId = setInterval(checkTime, 60000);
    startWallScheduleWatcher();
}
waitToStart();

// ==============================================================================
// 7. DESCARGAS FTP Y CONEXION AL SERVIDOR TBEE
// ==============================================================================
var os = require('os');

var lastCpuInfo = null;
function readProcStatCpu() {
    try {
        var stat = fs.readFileSync('/proc/stat', 'utf8');
        var line = stat.split('\n')[0];
        var parts = line.trim().split(/\s+/).slice(1).map(Number);
        var idle = (parts[3] || 0) + (parts[4] || 0);
        var total = parts.reduce(function (a, b) { return a + (b || 0); }, 0);
        return { idle: idle, total: total };
    } catch (e) {
        return null;
    }
}

function getURPHardData(callback) {
    try {
        // 1. Memoria RAM utilizada (%)
        var totalMem = os.totalmem();
        var freeMem = os.freemem();
        if (totalMem > 0) {
            memPercentUsed = Math.round(((totalMem - freeMem) * 100) / totalMem);
        }

        // 2. Uso real de CPU (%) mediante lectura de /proc/stat
        var cpuNow = readProcStatCpu();
        if (cpuNow) {
            if (lastCpuInfo) {
                var diffTotal = cpuNow.total - lastCpuInfo.total;
                var diffIdle = cpuNow.idle - lastCpuInfo.idle;
                if (diffTotal > 0) {
                    cpuUsage = Math.max(0, Math.min(100, Math.round(((diffTotal - diffIdle) * 100) / diffTotal)));
                }
            } else {
                var cpus = os.cpus();
                var numCpus = (cpus && cpus.length > 0) ? cpus.length : 4;
                var load1m = os.loadavg()[0] || 0;
                cpuUsage = Math.max(1, Math.min(100, Math.round((load1m / numCpus) * 100)));
            }
            lastCpuInfo = cpuNow;
        }

        if (isArm || isLinux) {
            var pending = 2;
            var doneOne = function () {
                pending--;
                if (pending <= 0 && typeof callback === 'function') {
                    var cb = callback;
                    callback = null;
                    cb();
                }
            };

            // 3. Temperatura de SoC Raspberry Pi (vcgencmd o thermal_zone0)
            exec("/usr/bin/vcgencmd measure_temp 2>/dev/null || /opt/vc/bin/vcgencmd measure_temp 2>/dev/null || cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null", function (err, stdout) {
                if (!err && stdout) {
                    var str = stdout.toString('utf8').trim();
                    var m = /temp=([0-9.]+)/.exec(str);
                    if (m && m[1]) {
                        temperature = parseFloat(parseFloat(m[1]).toFixed(1));
                    } else if (/^[0-9]+$/.test(str)) {
                        temperature = parseFloat((parseInt(str, 10) / 1000).toFixed(1));
                    }
                }
                doneOne();
            });

            // 4. Espacio libre en disco (formato legible: e.g., "12.4 GB")
            exec("df -k / | tail -n 1 | awk '{print $4}'", function (err, stdout) {
                if (!err && stdout) {
                    var availKb = parseInt(stdout.toString('utf8').trim(), 10);
                    if (!isNaN(availKb) && availKb > 0) {
                        var availGb = availKb / (1024 * 1024);
                        if (availGb >= 1) {
                            URPFreeSpace = availGb.toFixed(1) + ' GB';
                        } else {
                            URPFreeSpace = Math.round(availKb / 1024) + ' MB';
                        }
                    }
                }
                doneOne();
            });

            if (typeof callback === 'function') {
                setTimeout(function () {
                    if (typeof callback === 'function') {
                        var cb = callback;
                        callback = null;
                        cb();
                    }
                }, 1000);
            }
            return;
        }
    } catch (e) {}
    if (typeof callback === 'function') callback();
}
getURPHardData();
setInterval(function () { getURPHardData(); }, 60000);

function getIpAddress(callback) {
    try {
        var ifaces = os.networkInterfaces();
        var fallbackIp = '';
        var preferredIp = '';
        var ethMac = '';
        var wlanMac = '';
        var anyMac = '';

        for (var dev in ifaces) {
            if (!ifaces.hasOwnProperty(dev)) continue;
            // Ignorar interfaces virtuales o túneles
            if (/^(lo|docker|veth|br-|virbr|tun|tap)/.test(dev)) continue;
            var details = ifaces[dev];
            for (var i = 0; i < details.length; i++) {
                var d = details[i];
                if (d.family === 'IPv4' && !d.internal && d.address && d.address.indexOf('169.254.') !== 0) {
                    if (/^(eth|en)/.test(dev)) {
                        preferredIp = d.address;
                    } else if (/^(wl|wlan)/.test(dev) && !preferredIp) {
                        preferredIp = d.address;
                    } else if (!fallbackIp) {
                        fallbackIp = d.address;
                    }
                    if (d.mac && d.mac !== '00:00:00:00:00:00') {
                        if (/^(eth|en)/.test(dev)) ethMac = d.mac;
                        else if (/^(wl|wlan)/.test(dev)) wlanMac = d.mac;
                        else if (!anyMac) anyMac = d.mac;
                    }
                }
            }
        }

        if (!macAdd) {
            macAdd = ethMac || wlanMac || anyMac || '';
        }
        var detectedIp = preferredIp || fallbackIp;

        // Verificar mediante la ruta de salida real cuál es la IP activa en este instante
        if (isArm || isLinux) {
            exec("ip -4 route get 8.8.8.8 2>/dev/null", function (err, stdout) {
                var outStr = (!err && stdout) ? stdout.toString('utf8') : '';
                var match = /src\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(outStr);
                var routeIp = (match && match[1]) ? match[1] : '';
                if (routeIp) {
                    URPdata.URPIpAddress = routeIp;
                } else if (detectedIp) {
                    URPdata.URPIpAddress = detectedIp;
                }
                if (typeof callback === 'function') callback();
            });
            return;
        } else if (detectedIp) {
            URPdata.URPIpAddress = detectedIp;
        }
    } catch (e) {}
    if (typeof callback === 'function') callback();
}

function initNetwork() {
    getIpAddress(function () {
        getURPHardData(function () {
            if (!macAdd) {
                try {
                    require('getmac').getMac(function (err, mac) {
                        if (!err && mac) macAdd = mac;
                        getContents();
                        setWSCheckInterval();
                    });
                    return;
                } catch (e) {
                    macAdd = '00:00:00:00:00:00';
                }
            }
            getContents();
            setWSCheckInterval();
        });
    });
}
initNetwork();

function setWSCheckInterval() {
    if (WSCheckIntervalId != null)
        clearInterval(WSCheckIntervalId);
    WSCheckIntervalId = setInterval(getContents, WSCheckTime);
}

function checkContentsFTP() {
    if (!ftpHost || !ftpUser || ftpWorking) return;

    var scheduleArr = Array.isArray(schedule) ? schedule : [];
    if (scheduleArr.length === 0 && typeof schedule === 'object' && schedule !== null) {
        scheduleArr = Object.keys(schedule).map(function (k) { return schedule[k]; });
    }

    var itemsToVerify = [];
    for (var b = 0; b < scheduleArr.length; b++) {
        var blockItems = scheduleArr[b].contents || [];
        for (var bi = 0; bi < blockItems.length; bi++) {
            itemsToVerify.push(blockItems[bi]);
        }
    }

    if (itemsToVerify.length === 0) return;

    for (var i = 0; i < itemsToVerify.length; i++) {
        var itm = itemsToVerify[i];
        if (itm.ftp == 1) {
            var rawFileName = itm.content;
            var safeFileName = normalizeName(rawFileName);
            var localPath = contentBasePath + safeFileName;
            var needsDownload = false;

            if (!fileExist(localPath)) {
                if (fileExist(contentBasePath + rawFileName)) {
                    localPath = contentBasePath + rawFileName;
                } else {
                    needsDownload = true;
                }
            }

            if (!needsDownload && itm.md5) {
                var diskHash = getFileMD5(localPath);
                if (diskHash !== itm.md5.toLowerCase()) {
                    needsDownload = true;
                }
            }

            if (needsDownload) {
                var remoteFtpPath = buildFtpPath(ftpBasePath, URPdata.idCustomer, rawFileName);
                var task = {
                    tempPath: tempFolderPath + safeFileName,
                    contentPath: contentBasePath + safeFileName,
                    ftpPath: remoteFtpPath,
                    md5: itm.md5,
                    name: normalizeName(itm.name),
                    length: itm.length,
                    content: rawFileName
                };

                var inQueue = false;
                for (var q = 0; q < FTPcontents.length; q++) {
                    if (FTPcontents[q].contentPath === task.contentPath) {
                        inQueue = true;
                        break;
                    }
                }

                if (!inQueue) {
                    console.log('[FTP] Encolando descarga: ' + task.ftpPath);
                    FTPcontents.push(task);
                }
            }
        }
    }

    if (FTPcontents.length > 0) {
        if (hasCurl) {
            ftpWorking = true;
            initQueue(downloadQueue, FTPcontents);
        } else {
            connectFTP(function () {
                initQueue(downloadQueue, FTPcontents);
            });
        }
    }
}

var connectFTP = d.bind(function (callback) {
    if (!ftpHost || !ftpUser) {
        ftpWorking = false;
        return;
    }

    var clientOnConnect = function () {
        ftp.auth(ftpUser, ftpPass, function (err) {
            if (!err) {
                ftpWorking = true;
                if (callback) callback();
            } else {
                ftpWorking = false;
                console.error("[FTP] Error de autenticacion (" + ftpUser + "):", err);
            }
        });
    };

    try {
        if (ftp && ftp.raw) {
            try { ftp.raw.quit(); } catch (e) {}
        }
        ftp = new JSFtp({
            host: ftpHost,
            port: parseInt(ftpPort, 10) || 21,
            user: ftpUser,
            pass: ftpPass
        });
        ftp.on("connect", clientOnConnect);
        ftp.on("error", function (err) {
            ftpWorking = false;
            console.error("[FTP] Socket error:", err.message);
        });
    } catch (e) {
        ftpWorking = false;
    }
});

function handleDownloadedFile(content, tempPartPath, callback) {
    var calculatedMd5 = getFileMD5(tempPartPath);
    var matches = true;
    if (content.md5 && content.md5.length > 0) {
        matches = (calculatedMd5 === content.md5.toLowerCase());
    }

    if (matches) {
        try {
            fs.renameSync(tempPartPath, content.contentPath);
            console.log('[FTP] Archivo completado exitosamente: ' + content.contentPath);
        } catch (e) {
            try {
                fs.writeFileSync(content.contentPath, fs.readFileSync(tempPartPath));
                fs.unlinkSync(tempPartPath);
                console.log('[FTP] Archivo copiado exitosamente: ' + content.contentPath);
            } catch (e2) {
                console.error('[FTP] Error moviendo archivo descargado:', e2.message);
            }
        }

        // Si el archivo descargado es una imagen, convertir de inmediato a video MP4; si es video, analizar/optimizar en segundo plano
        if (isImg(content.content)) {
            var imgDuration = parseInt(content.length, 10);
            if (isNaN(imgDuration) || imgDuration <= 0) imgDuration = 10;
            var baseImgName = normalizeName(content.content).replace(/\.[^/.]+$/, "");
            var wallTagDl = isWallTileActive() ? ('_' + getWallSignature()) : '';
            imgToVideo(content.contentPath, baseImgName + wallTagDl + '_' + imgDuration + 's', imgDuration);
        } else if (isVideoFile(content.contentPath)) {
            scheduleVideoOptimization(content.contentPath);
        }

        var qIdx = getIndex(FTPcontents, content);
        if (qIdx !== -1) FTPcontents.splice(qIdx, 1);

        checkSchedule();
        if (callback) callback();
    } else {
        console.error("[FTP] MD5 mismatch para " + content.ftpPath);
        if (fs.existsSync(tempPartPath)) {
            try { fs.unlinkSync(tempPartPath); } catch (e) {}
        }
        var errIdx = getIndex(FTPcontents, content);
        if (errIdx !== -1) FTPcontents.splice(errIdx, 1);
        if (callback) callback();
    }
}

function runJsFtpDownload(content, tempPartPath, callback) {
    if (!ftp || !ftpWorking) {
        var connSettled = false;
        var connTimer = setTimeout(function () {
            if (!connSettled) {
                connSettled = true;
                ftpWorking = false;
                var idx = getIndex(FTPcontents, content);
                if (idx !== -1) FTPcontents.splice(idx, 1);
                if (callback) callback();
            }
        }, 15000);
        connectFTP(function () {
            if (connSettled) return;
            connSettled = true;
            clearTimeout(connTimer);
            runJsFtpDownload(content, tempPartPath, callback);
        });
        return;
    }

    if (fs.existsSync(tempPartPath)) {
        try { fs.unlinkSync(tempPartPath); } catch (e) {}
    }

    var isDone = false;
    var lastBytes = 0;
    var stallChecks = 0;
    var startedAt = Date.now();

    var progressMonitor = setInterval(function () {
        if (isDone) {
            clearInterval(progressMonitor);
            return;
        }
        var curBytes = 0;
        try {
            if (fs.existsSync(tempPartPath)) {
                curBytes = fs.statSync(tempPartPath).size;
            }
        } catch (e) {}

        if (curBytes > lastBytes) {
            var mbps = (((curBytes - lastBytes) * 8) / (30 * 1000 * 1000)).toFixed(2);
            lastBytes = curBytes;
            stallChecks = 0;
            console.log('[FTP] Descargando ' + path.basename(content.ftpPath) + ': ' + (curBytes / (1024 * 1024)).toFixed(2) + ' MB (' + mbps + ' Mbps)...');
        } else {
            stallChecks++;
        }

        if (stallChecks >= 4 || (Date.now() - startedAt) > 1800000) {
            isDone = true;
            clearInterval(progressMonitor);
            console.error('[FTP] Descarga estancada o timeout en ' + path.basename(content.ftpPath) + '. Reiniciando conexión...');
            try { if (ftp && ftp.raw) ftp.raw.quit(); } catch (e) {}
            try { if (ftp && ftp.socket) ftp.socket.destroy(); } catch (e) {}
            ftpWorking = false;
            var idx = getIndex(FTPcontents, content);
            if (idx !== -1) FTPcontents.splice(idx, 1);
            if (callback) callback();
        }
    }, 30000);

    ftp.get(content.ftpPath, tempPartPath, function (hadErr) {
        if (isDone) return;
        isDone = true;
        clearInterval(progressMonitor);

        if (hadErr) {
            console.error("[FTP] Error de transferencia: " + hadErr);
            if (fs.existsSync(tempPartPath)) {
                try { fs.unlinkSync(tempPartPath); } catch (e) {}
            }
            var idx = getIndex(FTPcontents, content);
            if (idx !== -1) FTPcontents.splice(idx, 1);
            if (callback) callback();
        } else {
            handleDownloadedFile(content, tempPartPath, callback);
        }
    });
}

var downloadFTP = d.bind(function (content, callback) {
    console.log('[FTP] Descargando: ' + content.ftpPath);
    var tempPartPath = content.tempPath + '.part';

    // Eliminar archivos .part viejos (>1h) para evitar mezclar versiones distintas
    if (fs.existsSync(tempPartPath)) {
        try {
            var partStat = fs.statSync(tempPartPath);
            if ((Date.now() - partStat.mtime.getTime()) > 3600000) {
                fs.unlinkSync(tempPartPath);
            }
        } catch (e) {}
    }

    // Motor rápido nativo en C (curl) con soporte de reanudación (-C -) y 0% overhead JS
    if (hasCurl && ftpHost && ftpUser) {
        var remoteRel = content.ftpPath.charAt(0) === '/' ? content.ftpPath.slice(1) : content.ftpPath;
        var encodedPath = remoteRel.split('/').map(function (seg) {
            return encodeURIComponent(seg);
        }).join('/');
        var ftpUrl = 'ftp://' + ftpHost + ':' + (parseInt(ftpPort, 10) || 21) + '/' + encodedPath;

        var startCurlAttempt = function (allowResume) {
            var curlArgs = [
                '--ftp-pasv',
                '--connect-timeout', '20',
                '--speed-limit', '1024',
                '--speed-time', '90',
                '-sS',
                '-o', tempPartPath,
                '-u', ftpUser + ':' + (ftpPass || '')
            ];

            if (allowResume && fs.existsSync(tempPartPath)) {
                try {
                    if (fs.statSync(tempPartPath).size > 0) {
                        curlArgs.push('-C', '-');
                    }
                } catch (e) {}
            }
            curlArgs.push(ftpUrl);

            var isDone = false;
            var lastBytes = 0;
            var startedAt = Date.now();
            var curlErr = '';
            var curlProc = null;

            var progressMonitor = setInterval(function () {
                if (isDone) {
                    clearInterval(progressMonitor);
                    return;
                }
                var curBytes = 0;
                try {
                    if (fs.existsSync(tempPartPath)) curBytes = fs.statSync(tempPartPath).size;
                } catch (e) {}
                if (curBytes > lastBytes) {
                    var mbps = (((curBytes - lastBytes) * 8) / (30 * 1000 * 1000)).toFixed(2);
                    lastBytes = curBytes;
                    console.log('[FTP:CURL] ' + path.basename(content.ftpPath) + ': ' + (curBytes / (1024 * 1024)).toFixed(2) + ' MB (' + mbps + ' Mbps)...');
                }
                if ((Date.now() - startedAt) > 1800000) {
                    isDone = true;
                    clearInterval(progressMonitor);
                    try { if (curlProc) curlProc.kill('SIGKILL'); } catch (e) {}
                    var idx = getIndex(FTPcontents, content);
                    if (idx !== -1) FTPcontents.splice(idx, 1);
                    if (callback) callback();
                }
            }, 30000);

            try {
                curlProc = spawn('curl', curlArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
                if (curlProc.stderr) {
                    curlProc.stderr.on('data', function (chunk) {
                        curlErr += chunk.toString('utf8');
                        if (curlErr.length > 1024) curlErr = curlErr.slice(-1024);
                    });
                }
                curlProc.on('error', function () {
                    if (isDone) return;
                    isDone = true;
                    clearInterval(progressMonitor);
                    runJsFtpDownload(content, tempPartPath, callback);
                });
                curlProc.on('close', function (code) {
                    if (isDone) return;
                    isDone = true;
                    clearInterval(progressMonitor);

                    if (code === 0 && fs.existsSync(tempPartPath)) {
                        var elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
                        var totalMb = (fs.statSync(tempPartPath).size / (1024 * 1024)).toFixed(2);
                        console.log('[FTP:CURL] Descarga completada (' + totalMb + ' MB en ' + elapsedSec.toFixed(1) + 's)');
                        handleDownloadedFile(content, tempPartPath, callback);
                        return;
                    }

                    // Si el servidor FTP rechazó reanudar (-C -), reintentar desde 0 una vez
                    if (allowResume && (code === 33 || code === 36)) {
                        try { if (fs.existsSync(tempPartPath)) fs.unlinkSync(tempPartPath); } catch (e) {}
                        startCurlAttempt(false);
                        return;
                    }

                    console.warn('[FTP:CURL] Falló (code ' + code + '): ' + (curlErr.trim() || 'sin detalle') + '. Usando fallback JSFtp...');
                    runJsFtpDownload(content, tempPartPath, callback);
                });
            } catch (e) {
                if (!isDone) {
                    isDone = true;
                    clearInterval(progressMonitor);
                    runJsFtpDownload(content, tempPartPath, callback);
                }
            }
        };

        startCurlAttempt(true);
        return;
    }

    runJsFtpDownload(content, tempPartPath, callback);
});

var initQueue = d.bind(function (queue, queueElements) {
    for (var i = 0; i < queueElements.length; i++) {
        queue.push(queueElements[i], function () {});
    }
});

var downloadQueue = async.queue(downloadFTP, 1);
downloadQueue.drain = function () {
    ftpWorking = false;
    try { if (ftp && ftp.raw) ftp.raw.quit(); } catch (e) {}
    if (FTPcontents.length > 0) {
        if (hasCurl) {
            ftpWorking = true;
            initQueue(downloadQueue, FTPcontents);
        } else {
            connectFTP(function () { initQueue(downloadQueue, FTPcontents); });
        }
    }
};

function getIndex(arr, val) {
    for (var i = 0; i < arr.length; i++) {
        if (arr[i].contentPath === val.contentPath) return i;
    }
    return -1;
}

var isUpdatingCode = false;
function isNewerVersion(remoteVer, localVer) {
    if (!remoteVer || !localVer) return false;
    var r = String(remoteVer).trim().split('.');
    var l = String(localVer).trim().split('.');
    for (var i = 0; i < 3; i++) {
        var rv = parseInt(r[i], 10) || 0;
        var lv = parseInt(l[i], 10) || 0;
        if (rv > lv) return true;
        if (rv < lv) return false;
    }
    return false;
}

function checkURPVersion(remoteVersion, remoteMD5) {
    if (URPUpdated || isUpdatingCode) return;
    if (!isNewerVersion(remoteVersion, URPVersion)) return;

    isUpdatingCode = true;
    var updateUrl = 'http://' + baseUrl + '/URP/' + URPType + '.js';
    var tempNewPath = tempFolderPath + URPType + '.new.js';
    var targetPath = __filename || (basePath + URPType + '.js');

    console.log('[OTA] Nueva versión disponible en servidor: ' + remoteVersion + ' (actual: ' + URPVersion + '). Descargando desde ' + updateUrl);

    request({ url: updateUrl, encoding: null, timeout: 20000, followRedirect: true }, function (err, res, body) {
        if (err || !res || res.statusCode !== 200 || !body || body.length < 5000) {
            console.error('[OTA] Error descargando actualización (status=' + (res ? res.statusCode : 'ERR') + ')');
            isUpdatingCode = false;
            return;
        }

        var downloadedMd5 = crypto.createHash('md5').update(body).digest('hex').toLowerCase();
        if (remoteMD5 && String(remoteMD5).trim().length === 32) {
            if (downloadedMd5 !== String(remoteMD5).trim().toLowerCase()) {
                console.error('[OTA] MD5 inválido en actualización. Esperado=' + remoteMD5 + ' Recibido=' + downloadedMd5);
                isUpdatingCode = false;
                return;
            }
        }

        try {
            fs.writeFileSync(tempNewPath, body);
            execSync('node --check "' + tempNewPath + '"', { stdio: 'ignore' });
        } catch (chkErr) {
            console.error('[OTA] El archivo descargado tiene errores de sintaxis. Abortando actualización.');
            try { if (fs.existsSync(tempNewPath)) fs.unlinkSync(tempNewPath); } catch (e) {}
            isUpdatingCode = false;
            return;
        }

        try {
            if (fs.existsSync(targetPath)) {
                try { fs.writeFileSync(targetPath + '.bak', fs.readFileSync(targetPath)); } catch (be) {}
            }
            try {
                fs.renameSync(tempNewPath, targetPath);
            } catch (re) {
                fs.writeFileSync(targetPath, fs.readFileSync(tempNewPath));
                fs.unlinkSync(tempNewPath);
            }
            URPUpdated = true;
            isUpdatingCode = false;
            console.log('[OTA] Actualización a v' + remoteVersion + ' verificada. Reiniciando servicio para aplicar...');
            stopOmx(function () {
                exec('pm2 restart all 2>/dev/null || true', function () {
                    setTimeout(function () { process.exit(0); }, 500);
                });
            });
        } catch (applyErr) {
            console.error('[OTA] Error aplicando actualización:', applyErr.message);
            isUpdatingCode = false;
        }
    });
}

// ==============================================================================
// 7B. AUTO-ACTUALIZACION REMOTA DESDE GITHUB (OTA SIN TOCAR EL SERVIDOR)
// ==============================================================================
var GITHUB_OTA_ENABLED = true;
var GITHUB_OTA_REPO = 'JulianDS95/URPSignageTv';
var GITHUB_OTA_BRANCH = 'main';
var GITHUB_OTA_INTERVAL_MS = 300000; // Verifica cada 5 minutos
var lastFailedGithubMd5 = '';

function getGithubOtaToken() {
    if (process.env.GITHUB_TOKEN && String(process.env.GITHUB_TOKEN).trim()) {
        return String(process.env.GITHUB_TOKEN).trim();
    }
    var tokenFile = basePath + '.github_token';
    try {
        if (fs.existsSync(tokenFile)) {
            var tok = fs.readFileSync(tokenFile, 'utf8').trim();
            if (tok) return tok;
        }
    } catch (e) {}
    return '';
}

function syncCompanionWallScript(branch, headers) {
    if (!GITHUB_OTA_ENABLED || !GITHUB_OTA_REPO) return;
    var wallShUrl = 'https://raw.githubusercontent.com/' + GITHUB_OTA_REPO + '/' + branch + '/urp-wall.sh?t=' + Date.now();
    var wallTarget = basePath + 'urp-wall.sh';
    var wallTmp = tempFolderPath + 'urp-wall.github.tmp.sh';
    request({ url: wallShUrl, headers: headers, encoding: 'utf8', timeout: 15000, followRedirect: true }, function (err, res, body) {
        if (err || !res || res.statusCode !== 200 || !body || body.indexOf('URP_WALL_NODE_EOF') === -1) return;
        try {
            if (!fs.existsSync(tempFolderPath)) fs.mkdirSync(tempFolderPath);
            fs.writeFileSync(wallTmp, body, 'utf8');
            execSync('bash -n "' + wallTmp + '"', { stdio: 'ignore' });
            var curMd5 = getFileMD5(wallTarget);
            var newMd5 = crypto.createHash('md5').update(body).digest('hex').toLowerCase();
            if (!curMd5 || curMd5.toLowerCase() !== newMd5) {
                try { fs.renameSync(wallTmp, wallTarget); } catch (re) {
                    fs.writeFileSync(wallTarget, body, 'utf8');
                    try { fs.unlinkSync(wallTmp); } catch (ue) {}
                }
                try { fs.chmodSync(wallTarget, '755'); } catch (ce) {}
                exec('sudo -n ln -sf /home/pi/URP/urp-wall.sh /usr/local/bin/urp-wall 2>/dev/null || true');
                console.log('[OTA:GITHUB] Configurador urp-wall.sh actualizado.');
            } else {
                try { fs.unlinkSync(wallTmp); } catch (ue) {}
            }
        } catch (e) {
            try { if (fs.existsSync(wallTmp)) fs.unlinkSync(wallTmp); } catch (ue) {}
        }
    });
}

function checkGithubOTA(branchOverride, manualCallback) {
    if (typeof branchOverride === 'function') {
        manualCallback = branchOverride;
        branchOverride = null;
    }
    if (!GITHUB_OTA_ENABLED || !GITHUB_OTA_REPO || URPUpdated || isUpdatingCode) {
        if (manualCallback) manualCallback({ updated: false, reason: 'busy_or_disabled' });
        return;
    }

    var branch = branchOverride || GITHUB_OTA_BRANCH || 'main';
    var targetPath = __filename || (basePath + URPType + '.js');
    var localMd5 = getFileMD5(targetPath);
    var ghUrl = 'https://raw.githubusercontent.com/' + GITHUB_OTA_REPO + '/' + branch + '/' + URPType + '.js?t=' + Date.now();
    var token = getGithubOtaToken();

    var headers = {
        'User-Agent': 'URP-Signage-Client/' + URPVersion,
        'Cache-Control': 'no-cache'
    };
    if (token) {
        headers['Authorization'] = 'Bearer ' + token;
    }

    isUpdatingCode = true;
    request({ url: ghUrl, headers: headers, encoding: null, timeout: 20000, followRedirect: true }, function (err, res, body) {
        if (!err && res && res.statusCode === 404 && !branchOverride && branch === 'main') {
            isUpdatingCode = false;
            return checkGithubOTA('master', manualCallback);
        }

        if (err || !res || res.statusCode !== 200 || !body || body.length < 5000) {
            isUpdatingCode = false;
            if (manualCallback) manualCallback({ updated: false, reason: 'download_error', status: res ? res.statusCode : 'ERR' });
            return;
        }

        var bodyStr = body.toString('utf8');
        if (bodyStr.indexOf("var URPType = 'URPPI3'") === -1) {
            isUpdatingCode = false;
            if (manualCallback) manualCallback({ updated: false, reason: 'invalid_payload' });
            return;
        }

        var downloadedMd5 = crypto.createHash('md5').update(body).digest('hex').toLowerCase();
        if (localMd5 && downloadedMd5 === localMd5.toLowerCase()) {
            isUpdatingCode = false;
            if (manualCallback) manualCallback({ updated: false, reason: 'up_to_date', version: URPVersion });
            return;
        }

        if (lastFailedGithubMd5 && downloadedMd5 === lastFailedGithubMd5) {
            isUpdatingCode = false;
            if (manualCallback) manualCallback({ updated: false, reason: 'previously_failed_syntax' });
            return;
        }

        var verMatch = bodyStr.match(/var\s+URPVersion\s*=\s*['"]([^'"]+)['"]/);
        var remoteVersion = verMatch ? verMatch[1] : URPVersion;
        var tempNewPath = tempFolderPath + URPType + '.github.new.js';

        console.log('[OTA:GITHUB] Nuevo código detectado en ' + GITHUB_OTA_REPO + '/' + branch + ' (v' + remoteVersion + ', md5=' + downloadedMd5.slice(0, 8) + '). Validando...');

        try {
            if (!fs.existsSync(tempFolderPath)) fs.mkdirSync(tempFolderPath);
            fs.writeFileSync(tempNewPath, body);
            execSync('node --check "' + tempNewPath + '"', { stdio: 'ignore' });
        } catch (chkErr) {
            console.error('[OTA:GITHUB] El archivo en GitHub tiene error de sintaxis. Se mantiene la versión actual.');
            lastFailedGithubMd5 = downloadedMd5;
            try { if (fs.existsSync(tempNewPath)) fs.unlinkSync(tempNewPath); } catch (e) {}
            isUpdatingCode = false;
            if (manualCallback) manualCallback({ updated: false, reason: 'syntax_error' });
            return;
        }

        try {
            if (fs.existsSync(targetPath)) {
                try { fs.writeFileSync(targetPath + '.bak', fs.readFileSync(targetPath)); } catch (be) {}
            }
            try {
                fs.renameSync(tempNewPath, targetPath);
            } catch (re) {
                fs.writeFileSync(targetPath, fs.readFileSync(tempNewPath));
                fs.unlinkSync(tempNewPath);
            }
            try { fs.chmodSync(targetPath, '755'); } catch (ce) {}

            URPUpdated = true;
            isUpdatingCode = false;
            console.log('[OTA:GITHUB] Actualización aplicada (v' + remoteVersion + '). Reiniciando reproductor...');
            syncCompanionWallScript(branch, headers);
            if (manualCallback) manualCallback({ updated: true, version: remoteVersion });

            stopOmx(function () {
                exec('pm2 restart URP 2>/dev/null || pm2 restart all 2>/dev/null || true', function () {
                    setTimeout(function () { process.exit(0); }, 500);
                });
            });
        } catch (applyErr) {
            console.error('[OTA:GITHUB] Error aplicando actualización:', applyErr.message);
            isUpdatingCode = false;
            if (manualCallback) manualCallback({ updated: false, reason: 'write_error' });
        }
    });
}

if (GITHUB_OTA_ENABLED && (isArm || isLinux)) {
    setTimeout(function () { checkGithubOTA(); }, 25000);
    setInterval(function () { checkGithubOTA(); }, GITHUB_OTA_INTERVAL_MS);
}

function callWS() {
    getIpAddress(function () {
        getURPHardData(function () {
            var date = new Date();
            var options = {
                url: 'http://' + baseUrl + '/ws/URP.php',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                json: true,
                timeout: 10000,
                body: {
                    macAddress: macAdd,
                    ip: URPdata.URPIpAddress,
                    port: URPPort,
                    day: date.getDate(),
                    month: date.getMonth() + 1,
                    weekDay: date.getDay() + 1,
                    uptime: Math.round(process.uptime()),
                    downloading: ftpWorking,
                    freeSpace: URPFreeSpace,
                    temperature: temperature,
                    memPercentUsed: memPercentUsed,
                    cpuUsage: cpuUsage,
                    idContent: URPNowPlaying,
                    type: URPType,
                    version: URPVersion
                }
            };

            request(options, function (err, httpResponse, data) {
                if (!err && httpResponse && httpResponse.statusCode == 200) {
                    respuesta = true;
                    if (data && typeof data === 'object') {
                        // Comando remoto 1: Reinicio confirmado desde el servidor
                        if (data.reboot === 1 || data.reboot === '1') {
                            var rebootAck = {
                                url: 'http://' + baseUrl + '/ws/updateRebootDisplay.php',
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                json: true,
                                timeout: 5000,
                                body: {
                                    idDisplay: data.idDisplay || URPdata.idDisplay,
                                    reboot: 0
                                }
                            };
                            request(rebootAck, function () {
                                resetURP();
                            });
                            return;
                        }

                        // Comando remoto 2: Apagado desde el servidor (si la API lo envía por WS)
                        if (data.shutdown === 1 || data.shutdown === '1') {
                            var shutdownAck = {
                                url: 'http://' + baseUrl + '/ws/updateShutdownDisplay.php',
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                json: true,
                                timeout: 3000,
                                body: {
                                    idDisplay: data.idDisplay || URPdata.idDisplay,
                                    shutdown: 0
                                }
                            };
                            request(shutdownAck, function () {
                                shutdownURP();
                            });
                            return;
                        }

                        // Comando remoto 3: Eliminar contenido desde el servidor (si la API lo envía por WS)
                        if (data.deleteContents === 1 || data.deleteContents === '1' || data.deleteContent === 1 || data.deleteContent === '1') {
                            deleteContentFiles();
                        }

                        if (!URPUpdated && data.URPVersion) {
                            checkURPVersion(data.URPVersion, data.URPCodeMD5);
                        }

                        URPdata.idURP = data.idURP;
                        ftpHost = data.ftpHost;
                        ftpPort = data.ftpPort || 21;
                        ftpUser = data.ftpUser;
                        if (data.ftpPass) ftpPass = decrypt(data.ftpPass);
                        ftpBasePath = data.ftpBasePath || '';

                        if (data.checkTime && data.checkTime * 60000 !== WSCheckTime) {
                            WSCheckTime = data.checkTime * 60000;
                            setWSCheckInterval();
                        }

                        var prevWallActive = isWallActive();
                        if (data.videoWall == 1 || data.videoWall === '1' || data.videoWall === true) {
                            URPdata.isVideoWall = true;
                            wall = data.wall || [];
                        } else {
                            URPdata.isVideoWall = false;
                            wall = [];
                        }
                        var nextWallActive = isWallActive();
                        if (prevWallActive !== nextWallActive) {
                            console.log('[VIDEOWALL:REMOTO] tbee.tv cambió Video Wall -> ' + (nextWallActive ? 'ACTIVADO (' + wallConfig.mode + ' ' + wallConfig.rows + 'x' + wallConfig.cols + ' #' + wallConfig.screenId + ')' : 'DESACTIVADO (Modo Normal URPPI3)'));
                            stopOmx(function () {
                                setTimeout(function () { checkSchedule(); }, 300);
                            });
                        }

                        URPdata.idCustomer = data.idCustomer;
                        URPdata.idZone = data.idZone;
                        URPdata.idStore = data.idStore;
                        URPdata.idDisplay = data.idDisplay;
                        URPdata.autoReboot = data.autoReboot;
                        URPdata.autoRebootDay = data.autoRebootDay;
                        URPdata.autoRebootHour = data.autoRebootHour;
                        URPdata.autoRebootMinute = data.autoRebootMinute;
                        URPdata.vertical = (data.vertical == 1);

                        if (data.blocks != undefined) {
                            if (data.blocks.length > 0) {
                                var newBlocksStr = JSON.stringify(data.blocks);
                                var oldBlocksStr = JSON.stringify(schedule);
                                if (newBlocksStr !== oldBlocksStr) {
                                    console.log("[SCHEDULE] Nueva programación recibida del servidor (" + data.blocks.length + " bloques).");
                                    schedule = data.blocks;
                                    if (db) db.put('schedule', newBlocksStr);
                                    checkContentsFTP();
                                    checkSchedule();
                                } else {
                                    checkContentsFTP();
                                }
                            } else {
                                // Si el manager vació la programación, detener y limpiar bloques locales
                                console.log("[SCHEDULE] Programación vacía en servidor. Deteniendo reproducción.");
                                schedule = [];
                                contents = [];
                                max = 0;
                                blockPlaying = 0;
                                URPNowPlaying = 0;
                                if (db) {
                                    db.del('schedule', function () {});
                                    db.del('contents', function () {});
                                }
                                stopOmx(function () {
                                    setBackground();
                                });
                            }
                        }
                        if (db) db.put('URPData', JSON.stringify(URPdata));
                    }
                }
            });
        });
    });
}

function getContents() {
    if (!offline) {
        require('dns').resolve(baseUrl, function (err) {
            if (err) {
                iConn = false;
                // Si no hay conexion con tbee.tv, seguir reproduciendo videos de disco
                emergencyDiskPlayback();
            } else {
                iConn = true;
                callWS();
            }
        });
    } else {
        callWS();
    }
}

function clearDirectoryFiles(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) return;
        var files = fs.readdirSync(dirPath);
        for (var idx = 0; idx < files.length; idx++) {
            var filePath = path.join(dirPath, files[idx]);
            try {
                var stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    clearDirectoryFiles(filePath);
                    fs.rmdirSync(filePath);
                } else {
                    fs.unlinkSync(filePath);
                }
            } catch (err) {
                console.error('[DELETE] Error borrando ' + filePath + ':', err.message);
            }
        }
    } catch (e) {
        console.error('[DELETE] Error leyendo directorio ' + dirPath + ':', e.message);
    }
}

function execDeleteContents(callback) {
    console.log('* * * ELIMINANDO TODO EL CONTENIDO (deleteContents) * * *');
    FTPcontents = [];
    ftpWorking = false;
    failedSeamlessHashes = {};
    noOptNeededMap = {};
    failedOptMap = {};
    stopOmx(function () {
        clearDirectoryFiles(contentBasePath);
        clearDirectoryFiles(tempFolderPath);
        clearDirectoryFiles(seamlessBasePath);
        clearDirectoryFiles(optimizedBasePath);
        schedule = [];
        contents = [];
        max = 0;
        blockPlaying = 0;
        URPNowPlaying = 0;
        if (db) {
            db.del('schedule', function () {});
            db.del('contents', function () {});
        }
        setBackground();
        console.log('[DELETE] Carpeta content/ y caché limpiados correctamente.');
        if (typeof callback === 'function') callback();
    });
}

function deleteContentFiles(callback) {
    if (URPdata.isVideoWall && Array.isArray(wall) && wall.length > 0) {
        for (var w = 0; w < wall.length; w++) {
            request.get('http://' + wall[w].ip + ':' + wall[w].port + '/deleteContents').on('error', function () {});
        }
    }
    execDeleteContents(callback);
}

function rebootDevice() {
    console.log('* * * REINICIANDO DISPOSITIVO (REBOOT URPPI3) * * *');
    stopOmx(function () {
        if (isArm || isLinux) {
            exec("sudo /sbin/reboot || sudo reboot || sudo systemctl reboot", function (err) {
                if (err) console.error('[REBOOT ERROR]', err.message);
            });
        }
    });
}

function resetURP() {
    if (URPdata.isVideoWall && Array.isArray(wall) && wall.length > 0) {
        for (var w = 0; w < wall.length; w++) {
            request.get('http://' + wall[w].ip + ':' + wall[w].port + '/reboot').on('error', function () {});
        }
        setTimeout(rebootDevice, 45000);
    } else {
        rebootDevice();
    }
}

function shutdownDevice() {
    console.log('* * * APAGANDO DISPOSITIVO (SHUTDOWN URPPI3) * * *');
    stopOmx(function () {
        if (isArm || isLinux) {
            exec("sudo /sbin/shutdown -h now || sudo shutdown -h now || sudo poweroff || sudo systemctl poweroff", function (err) {
                if (err) console.error('[SHUTDOWN ERROR]', err.message);
            });
        }
    });
}

function shutdownURP() {
    if (URPdata.isVideoWall && Array.isArray(wall) && wall.length > 0) {
        for (var w = 0; w < wall.length; w++) {
            request.get('http://' + wall[w].ip + ':' + wall[w].port + '/shutdown').on('error', function () {});
        }
        setTimeout(shutdownDevice, 45000);
    } else {
        shutdownDevice();
    }
}

// Servidor Express local para control remoto desde tbee.tv Manager
var express = require('express');
var app = express();
app.use(express.static(__dirname + '/web'));

// Cabeceras CORS completas para permitir comandos directos desde tbee.tv
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.get('/play', function (req, res) {
    checkSchedule();
    res.status(200).send('Play');
});
app.get('/stop', function (req, res) {
    stopOmx();
    res.status(200).send('Stop');
});
app.get('/pause', function (req, res) {
    if (refreshIntervalId != null) clearInterval(refreshIntervalId);
    res.status(200).send('Pause');
});
app.get('/resetContent', function (req, res) {
    blockPlaying = 0;
    checkSchedule();
    res.status(200).send('Reset Content');
});
app.get('/reboot', function (req, res) {
    res.status(200).send('Reboot');
    setTimeout(resetURP, 200);
});
app.get('/shutdown', function (req, res) {
    res.status(200).send('Shutdown');
    setTimeout(shutdownURP, 200);
});
app.get('/deleteContents', function (req, res) {
    res.status(200).send('Delete Contents');
    deleteContentFiles();
});
app.get('/deleteContent', function (req, res) {
    res.status(200).send('Delete Contents');
    deleteContentFiles();
});
app.get('/contents', function (req, res) {
    try {
        var files = fs.readdirSync(contentBasePath);
        res.json({ contents: files.map(function (f) { return { file: f }; }) });
    } catch (e) {
        res.json({ contents: [] });
    }
});
app.get('/schedule', function (req, res) {
    var date = new Date();
    res.json({
        connection: iConn,
        hour: date.getHours(),
        minutes: date.getMinutes(),
        playing: filesPlaying,
        blockPlaying: blockPlaying,
        schedule: schedule
    });
});
app.get('/URPTemperature', function (req, res) {
    res.json({ temperature: temperature });
});
app.get('/URPmemPercentUsed', function (req, res) {
    res.json({ memPercentUsed: memPercentUsed });
});
app.get('/URPcpuUsage', function (req, res) {
    res.json({ cpuUsage: cpuUsage });
});
app.get('/update', function (req, res) {
    checkGithubOTA(function (result) {
        res.json(result);
    });
});
app.get('/wall', function (req, res) {
    loadWallConfig();
    res.json({
        active: isWallActive(),
        tileActive: isWallTileActive(),
        activationMode: wallConfig.activationMode,
        serverVideoWallFlag: Boolean(URPdata && URPdata.isVideoWall),
        signature: getWallSignature(),
        config: wallConfig,
        syncStatus: wallSyncStatus,
        masterState: wallMasterState
    });
});
app.get('/wall/sync', function (req, res) {
    loadWallConfig();
    var dur = wallMasterState.duration || 0;
    var ageSec = wallMasterState.ts ? ((Date.now() - wallMasterState.ts) / 1000) : 0;
    var livePos = wallMasterState.timePos || 0;
    if (dur > 0 && ageSec >= 0 && ageSec < 5) {
        livePos = (livePos + ageSec) % dur;
    }
    res.json({
        screenId: wallConfig.screenId,
        mode: wallConfig.mode,
        file: wallMasterState.file,
        timePos: livePos,
        duration: dur,
        ts: Date.now()
    });
});

var server = http.createServer(app);
server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
        console.warn("[SERVER] Puerto " + URPPort + " ya ocupado por otra instancia previa. La reproducción continuará normalmente.");
    } else {
        console.error("[SERVER ERROR]", err.message);
    }
});
try {
    server.listen(URPPort, function () {
        console.log("URPPI3 Server escuchando en puerto " + URPPort);
    });
} catch (e) {
    console.warn("[SERVER] Excepción al escuchar:", e.message);
}

process.on('exit', function () {
    URPActive = false;
    stopOmx();
    killBackground();
    if (curtainProc != null) {
        try { curtainProc.kill('SIGKILL'); } catch (e) {}
        curtainProc = null;
    }
});
