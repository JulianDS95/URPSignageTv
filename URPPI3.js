var URPActive = true;
var URPType = 'URPPI3';
var URPVersion = '2.5.0';
var URPUpdated = false;
var isArm = process.arch === 'arm' || process.arch === 'arm64';
var isLinux = process.platform === 'linux';
var baseUrl = 'tbee.tv';
var offline = false;
var procBackgroundImage = null;
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
var freeDiskMb = -1;
var temperature = 0;
var memPercentUsed = 0;
var cpuUsage = 0;
var blockPlaying = 0;
var respuesta = false;
var isRendering = false;
var isConcatenating = false;
var playContentRunning = false;
var path = require('path');
var macAdd = '';
var URPNowPlaying = 0;
var fs = require('fs');
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;
var spawn = require('child_process').spawn;
var net = require('net');
var http = require('http');
var https = require('https');
var urlMod = require('url');
var crypto = require('crypto');
var osMod = require('os');
var _ = require('lodash');
var async = require('async');

// ==============================================================================
// 0. BUFFER DE LOGS EN MEMORIA (para Panel Web Local :8090) + ROLLBACK OTA
// ==============================================================================
var recentLogs = [];
var MAX_RECENT_LOGS = 80;
function pushLogLine(levelTag, argsArr) {
    try {
        var msg = Array.prototype.slice.call(argsArr).map(function (a) {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
        var nowStr = new Date().toISOString().slice(11, 19);
        recentLogs.push('[' + nowStr + '][' + levelTag + '] ' + msg);
        if (recentLogs.length > MAX_RECENT_LOGS) {
            recentLogs.shift();
        }
    } catch (e) {}
}
(function hookConsoleLogs() {
    var origLog = console.log;
    var origWarn = console.warn;
    var origErr = console.error;
    console.log = function () {
        pushLogLine('INFO', arguments);
        origLog.apply(console, arguments);
    };
    console.warn = function () {
        pushLogLine('WARN', arguments);
        origWarn.apply(console, arguments);
    };
    console.error = function () {
        pushLogLine('ERR', arguments);
        origErr.apply(console, arguments);
    };
})();

var otaPendingPath = basePath + '.ota_pending';
var otaBootSafe = false;
var otaRollbackHandled = false;

function attemptOtaRollback(reasonStr) {
    if (otaBootSafe || otaRollbackHandled) return false;
    try {
        if (!fs.existsSync(otaPendingPath)) return false;
        var pending = JSON.parse(fs.readFileSync(otaPendingPath, 'utf8') || '{}');
        var backupPath = pending.backupPath;
        var targetPath = pending.targetPath || __filename || (basePath + 'URPPI3-v2.5.js');
        if (backupPath && fs.existsSync(backupPath)) {
            otaRollbackHandled = true;
            console.error('[OTA:ROLLBACK] Fallo crítico durante arranque post-OTA (' + reasonStr + '). Restaurando respaldo...');
            try {
                fs.writeFileSync(targetPath, fs.readFileSync(backupPath));
            } catch (we) {}
            try { fs.unlinkSync(otaPendingPath); } catch (ue) {}
            return true;
        }
        try { fs.unlinkSync(otaPendingPath); } catch (ue2) {}
    } catch (e) {}
    return false;
}

if (fs.existsSync(otaPendingPath)) {
    setTimeout(function () {
        otaBootSafe = true;
        try {
            if (fs.existsSync(otaPendingPath)) {
                fs.unlinkSync(otaPendingPath);
                console.log('[OTA:ROLLBACK] Arranque estable confirmado (20s). Actualización v' + URPVersion + ' consolidada.');
            }
        } catch (e) {}
    }, 20000);
} else {
    otaBootSafe = true;
}

process.on('uncaughtException', function (err) {
    console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
    if (attemptOtaRollback(err ? err.message : 'uncaughtException')) {
        setTimeout(function () { process.exit(1); }, 300);
    }
});

// ==============================================================================
// 0A. DETECCION DE HARDWARE Y SESION GRAFICA (X11 / WAYLAND / DRM DIRECTO)
// ==============================================================================
var hasOmxplayer = false;
var hasMpv = false;
var hasCurl = false;
var hasNice = false;
var hasGrim = false;
var hasScrot = false;
var hasRaspi2png = false;
var piModelStr = '';
var totalRamMB = Math.round(osMod.totalmem() / (1024 * 1024));
var isPi4Or5 = false;
var isLowPowerPi = false;
var hasX11Display = false;
var hasWaylandDisplay = false;
var useDrmDirect = false;
var bootGraceDone = false;

setTimeout(function () {
    bootGraceDone = true;
    if (Array.isArray(schedule) && schedule.length > 0) {
        checkSchedule();
        setTimeout(prebuildAllScheduleBlocks, 2500);
    }
}, 5000);

function detectDisplaySession() {
    if (!isArm && !isLinux) return;
    hasX11Display = false;
    hasWaylandDisplay = false;
    try {
        if (fs.existsSync('/tmp/.X11-unix')) {
            var xFiles = fs.readdirSync('/tmp/.X11-unix');
            if (xFiles && xFiles.length > 0) hasX11Display = true;
        }
    } catch (e) {}
    try {
        var uid = (typeof process.getuid === 'function') ? process.getuid() : 1000;
        var rtDir = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
        if (fs.existsSync(rtDir)) {
            var rtEntries = fs.readdirSync(rtDir);
            for (var ri = 0; ri < rtEntries.length; ri++) {
                if (/^wayland-[0-9]+$/.test(rtEntries[ri])) {
                    hasWaylandDisplay = true;
                    break;
                }
            }
        }
    } catch (e) {}
    var forceDrm = (process.env.URP_DRM_MODE === '1') || Boolean(wallConfig && wallConfig.drmMode);
    useDrmDirect = hasMpv && (forceDrm || (!hasX11Display && !hasWaylandDisplay));
}

if (isArm || isLinux) {
    try { execSync('command -v omxplayer', { stdio: 'ignore' }); hasOmxplayer = true; } catch (e) {}
    try { execSync('command -v mpv', { stdio: 'ignore' }); hasMpv = true; } catch (e) {}
    try { execSync('command -v curl', { stdio: 'ignore' }); hasCurl = true; } catch (e) {}
    try { execSync('command -v nice', { stdio: 'ignore' }); hasNice = true; } catch (e) {}
    try { execSync('command -v grim', { stdio: 'ignore' }); hasGrim = true; } catch (e) {}
    try { execSync('command -v scrot', { stdio: 'ignore' }); hasScrot = true; } catch (e) {}
    try { execSync('command -v raspi2png', { stdio: 'ignore' }); hasRaspi2png = true; } catch (e) {}
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
    masterIp: '',
    drmMode: false
};
var wallConfigMtime = 0;
var lastWallSignatureLogged = '';

function loadWallConfig() {
    try {
        if (!fs.existsSync(wallConfigPath)) {
            wallConfig = {
                enabled: false, activationMode: 'server', mode: 'mirror', screenId: 1,
                rows: 1, cols: 1, row: 0, col: 0, bezelPx: 0,
                orientation: 0, syncMode: 'ntp', masterIp: '', drmMode: false
            };
            wallConfigMtime = 0;
            detectDisplaySession();
            return wallConfig;
        }
        var st = fs.statSync(wallConfigPath);
        if (st.mtime.getTime() === wallConfigMtime && wallConfigMtime > 0) {
            return wallConfig;
        }
        var parsed = JSON.parse(fs.readFileSync(wallConfigPath, 'utf8'));
        var rows = Math.max(1, Math.min(32, parseInt(parsed.rows, 10) || 1));
        var cols = Math.max(1, Math.min(32, parseInt(parsed.cols, 10) || 1));
        var total = rows * cols;
        var screenId = Math.min(999, Math.max(1, parseInt(parsed.screenId, 10) || 1));
        var effIdx = (screenId - 1) % total;
        var row = (typeof parsed.row === 'number' && parsed.row >= 0 && parsed.row < rows)
            ? parsed.row
            : Math.floor(effIdx / cols);
        var col = (typeof parsed.col === 'number' && parsed.col >= 0 && parsed.col < cols)
            ? parsed.col
            : (effIdx % cols);
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
            masterIp: String(parsed.masterIp || '').trim(),
            drmMode: Boolean(parsed.drmMode)
        };
        wallConfigMtime = st.mtime.getTime();
        detectDisplaySession();

        var sig = wallConfig.activationMode + '_' + wallConfig.enabled + '_' + wallConfig.mode + '_' + wallConfig.rows + 'x' + wallConfig.cols + '_id' + wallConfig.screenId + '_' + wallConfig.syncMode + '_drm' + useDrmDirect;
        if (sig !== lastWallSignatureLogged) {
            lastWallSignatureLogged = sig;
            console.log('[DISPLAY:SESION] Salida=' + (useDrmDirect ? 'DRM/KMS directo (sin X11)' : (hasWaylandDisplay ? 'Wayland' : 'X11')));
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
detectDisplaySession();

function getTargetVideoDims() {
    var isVert = isPortraitOrientation();
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
// 0C. CLIENTE HTTP/HTTPS NATIVO (REEMPLAZA A 'request' OBSOLETO)
// ==============================================================================
function httpRequest(opts, callback) {
    if (typeof opts === 'string') opts = { url: opts };
    var settled = false;
    var done = function (err, res, body) {
        if (settled) return;
        settled = true;
        if (typeof callback === 'function') callback(err, res, body);
    };

    var redirects = opts._redirects || 0;
    var maxRedirects = (opts.followRedirect === false) ? 0 : 5;
    var timeoutMs = opts.timeout || 15000;

    try {
        var parsed = urlMod.parse(opts.url);
        var isHttps = parsed.protocol === 'https:';
        var transport = isHttps ? https : http;
        var reqHeaders = Object.assign({}, opts.headers || {});
        var payload = null;

        if (opts.body !== undefined && opts.body !== null) {
            if (opts.json || typeof opts.body === 'object') {
                payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
                if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
            } else {
                payload = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8');
            }
            reqHeaders['Content-Length'] = payload.length;
        }

        var reqOpts = {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.path || '/',
            method: (opts.method || 'GET').toUpperCase(),
            headers: reqHeaders,
            timeout: timeoutMs
        };

        var req = transport.request(reqOpts, function (res) {
            var code = res.statusCode || 0;
            if ((code === 301 || code === 302 || code === 303 || code === 307 || code === 308) && res.headers.location && redirects < maxRedirects) {
                res.resume();
                var nextUrl = urlMod.resolve(opts.url, res.headers.location);
                var nextMethod = (code === 303) ? 'GET' : reqOpts.method;
                var nextOpts = Object.assign({}, opts, { url: nextUrl, method: nextMethod, _redirects: redirects + 1 });
                return httpRequest(nextOpts, done);
            }

            var chunks = [];
            res.on('data', function (chunk) { chunks.push(chunk); });
            res.on('end', function () {
                var buf = Buffer.concat(chunks);
                if (opts.encoding === null) {
                    return done(null, res, buf);
                }
                var txt = buf.toString(typeof opts.encoding === 'string' ? opts.encoding : 'utf8');
                if (opts.json) {
                    try {
                        return done(null, res, JSON.parse(txt));
                    } catch (je) {
                        return done(null, res, txt);
                    }
                }
                return done(null, res, txt);
            });
        });

        req.on('timeout', function () {
            req.destroy(new Error('HTTP timeout (' + timeoutMs + 'ms)'));
        });
        req.on('error', function (err) {
            done(err, null, null);
        });

        if (payload) req.write(payload);
        req.end();
    } catch (e) {
        done(e, null, null);
    }
}

// ==============================================================================
// 1. NEUTRALIZACION DEL ESCRITORIO + CORTINA NEGRA + ROTACION HDMI
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
    return { runtimeDir: runtimeDir, waylandDisplay: waylandDisp };
}

function getGuiEnv() {
    var wl = getWaylandEnv();
    var extra = {
        DISPLAY: process.env.DISPLAY || ':0',
        XAUTHORITY: getXauthPath(),
        XDG_RUNTIME_DIR: wl.runtimeDir
    };
    if (wl.waylandDisplay) extra.WAYLAND_DISPLAY = wl.waylandDisplay;
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
            console.log('[DISPLAY] Rotación GPU por reproductor (--video-rotate=' + getMpvVideoRotateDeg() + ').');
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
    if (useDrmDirect) {
        osScreenRotated = false;
        return;
    }
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
    if (!isArm && !isLinux || useDrmDirect) {
        osScreenRotated = false;
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
    if (useDrmDirect || !hasX11Display) return;
    if (!URPActive || curtainProc != null) return;
    var curtainPath = ensureBlackCurtainAsset();
    if (!fs.existsSync(curtainPath)) return;
    try {
        var env = Object.assign({}, process.env, { DISPLAY: ':0', XAUTHORITY: getXauthPath() });
        curtainProc = spawn('feh', ['-F', '-Z', '-x', '-Y', '-B', 'black', '-q', '--hide-pointer', curtainPath], { env: env });
        curtainProc.on('error', function () { curtainProc = null; });
        curtainProc.on('exit', function () {
            curtainProc = null;
            if (URPActive && !useDrmDirect && hasX11Display) {
                setTimeout(startBlackCurtain, 1000);
            }
        });
    } catch (e) {
        curtainProc = null;
    }
}

function suppressDesktopPopups() {
    if (!isArm && !isLinux || useDrmDirect) return;
    var xEnv = "export DISPLAY=:0; export XAUTHORITY=\"" + getXauthPath() + "\"; ";
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
    if (useDrmDirect) return;
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

        try {
            var labwcDir = homeBase + '/.config/labwc';
            ensureDir(labwcDir);
            var labwcAs = labwcDir + '/autostart';
            if (!fs.existsSync(labwcAs) || fs.readFileSync(labwcAs, 'utf8').indexOf('#URP_CLEAN') === -1) {
                fs.writeFileSync(labwcAs, "#URP_CLEAN\npkill -9 -f 'lwrespawn.*(pcmanfm|wf-panel)' 2>/dev/null || true\npkill -9 mako wf-panel-pi 2>/dev/null || true\n", 'utf8');
            }
        } catch (le) {}

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
                  "pkill -9 -x wf-panel-pi lxpanel xcompmgr picom compton mako dunst xfce4-notifyd notification-daemon lxqt-notificationd piwiz blueman-applet nm-applet zenity yad 2>/dev/null || true; " +
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
    detectDisplaySession();
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
    if ((isArm || isLinux) && !isPlaying && !useDrmDirect && hasX11Display) {
        var bgPath = basePath + 'background.png';
        if (procBackgroundImage == null && fs.existsSync(bgPath)) {
            try {
                procBackgroundImage = spawn('feh', ['-x', '-q', '-F', bgPath], {
                    env: Object.assign({}, process.env, { DISPLAY: ':0', XAUTHORITY: getXauthPath() })
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
// 2. MOTOR DE REPRODUCCION (OMXPLAYER / MPV X11-WAYLAND-DRM) + WATCHDOG IPC
// ==============================================================================
var currentPlaylist = [];
var currentMediaIndex = 0;
var activePlayerProcess = null;
var activePlayerBin = '';
var activeFehProcess = null;
var imageTimer = null;
var filesPlaying = [];
var playbackToken = 0;

function killMediaPlayersSync() {
    if (!isArm && !isLinux) return;
    try {
        execSync("killall -9 omxplayer.bin omxplayer mpv 2>/dev/null || true", { stdio: 'ignore' });
    } catch (e) {}
}

// ==============================================================================
// 2B. MOTOR DE SINCRONIZACION VIDEO WALL + WATCHDOG ANTI-CONGELAMIENTO (MPV IPC)
// ==============================================================================
var mpvIpcSocketPath = '/tmp/mpv-urp.sock';
var wallSyncTimer = null;
var wallSyncBusy = false;
var lastWallSeekAt = 0;
var wallMasterState = { timePos: 0, duration: 0, ts: 0, file: '' };
var wallSyncStatus = { active: false, mode: '', driftMs: 0, speed: 1, targetPos: 0, curPos: 0, lastSyncAt: 0, lastError: '' };
var watchdogLastPos = -1;
var watchdogStallCount = 0;
var watchdogBusy = false;

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

// Watchdog cada 15s: si mpv queda congelado en el mismo cuadro 45s seguidos, reinicia solo mpv
setInterval(function () {
    if (!isPlaying || !activePlayerProcess || activePlayerBin !== 'mpv' || watchdogBusy) return;
    if (!fs.existsSync(mpvIpcSocketPath)) return;
    watchdogBusy = true;
    mpvIpcRequest([['get_property', 'time-pos'], ['get_property', 'pause'], ['get_property', 'duration']], function (err, res) {
        watchdogBusy = false;
        if (err || !res || !res[1] || res[1].error !== 'success') return;
        var pos = parseFloat(res[1].data);
        var paused = Boolean(res[2] && res[2].data === true);
        var dur = (res[3] && res[3].error === 'success') ? parseFloat(res[3].data) : 0;
        if (isNaN(pos) || paused || (dur > 0 && dur <= 3)) {
            watchdogStallCount = 0;
            return;
        }
        if (watchdogLastPos >= 0 && Math.abs(pos - watchdogLastPos) < 0.05) {
            watchdogStallCount++;
            if (watchdogStallCount >= 3) {
                watchdogStallCount = 0;
                watchdogLastPos = -1;
                console.warn('[WATCHDOG] mpv congelado en pos=' + pos.toFixed(2) + 's durante 45s. Reiniciando reproductor...');
                stopOmx(function () {
                    setTimeout(function () { checkSchedule(); }, 300);
                });
            }
        } else {
            watchdogStallCount = 0;
            watchdogLastPos = pos;
        }
    });
}, 15000);

function applyWallTargetDrift(curPos, duration, targetPos) {
    var diff = targetPos - curPos;
    if (diff > duration / 2) diff -= duration;
    if (diff < -duration / 2) diff += duration;

    wallSyncStatus.curPos = Number(curPos.toFixed(3));
    wallSyncStatus.targetPos = Number(targetPos.toFixed(3));
    wallSyncStatus.driftMs = Math.round(diff * 1000);
    wallSyncStatus.lastSyncAt = Date.now();
    wallSyncStatus.lastError = '';

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

            if (wallConfig.syncMode === 'master' && wallConfig.masterIp) {
                var reqStart = Date.now();
                httpRequest({
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

            var targetPosNtp = ((Date.now() / 1000) % duration);
            applyWallTargetDrift(curPos, duration, targetPosNtp);
            wallSyncBusy = false;
        });
    }, 1500);
}

function stopCurrentMedia(callback) {
    playbackToken++;
    stopWallSync();
    watchdogStallCount = 0;
    watchdogLastPos = -1;
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
        activePlayerBin = '';
    }
    if (activeFehProcess != null) {
        try {
            activeFehProcess.removeAllListeners('exit');
            activeFehProcess.removeAllListeners('error');
            activeFehProcess.kill('SIGKILL');
        } catch (e) {}
        activeFehProcess = null;
    }
    killMediaPlayersSync();
    if (typeof callback === 'function') setTimeout(callback, 50);
}

function playCurrentIndex() {
    if (!isPlaying || currentPlaylist.length === 0) return;

    if (currentMediaIndex >= currentPlaylist.length) {
        currentMediaIndex = 0;
    }

    var item = currentPlaylist[currentMediaIndex];
    if (item && item.idContent) {
        URPNowPlaying = item.idContent;
    }
    var fullPath = path.isAbsolute(item.file) ? item.file : path.resolve(contentBasePath, item.file);

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

    var needsSyncKill = (activePlayerProcess != null);
    if (activePlayerProcess != null) {
        try {
            activePlayerProcess.removeAllListeners('exit');
            activePlayerProcess.removeAllListeners('error');
            activePlayerProcess.kill('SIGKILL');
        } catch (e) {}
        activePlayerProcess = null;
        activePlayerBin = '';
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

    // CASO A: IMAGEN (respaldo mientras se convierte a MP4)
    if (isImage) {
        var duration = (item.duration && item.duration > 0) ? parseInt(item.duration, 10) : 10;
        if (isNaN(duration) || duration <= 0) duration = 10;
        console.log("[PLAYER:IMAGEN] Mostrando (" + duration + "s): " + path.basename(fullPath));

        if ((useDrmDirect || mpvRotateDeg > 0 || !hasX11Display) && hasMpv) {
            var imgMpvArgs = [
                '--fs', '--no-osc', '--no-osd-bar', '--really-quiet',
                '--no-input-default-bindings', '--cursor-autohide=always', '--ontop',
                '--image-display-duration=inf'
            ];
            if (useDrmDirect) {
                imgMpvArgs.push('--vo=gpu,drm', '--gpu-context=drm');
            }
            if (mpvRotateDeg > 0) imgMpvArgs.push('--video-rotate=' + mpvRotateDeg);
            imgMpvArgs.push(fullPath);
            try {
                activeFehProcess = spawn('mpv', imgMpvArgs, { env: env });
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

    // CASO B: VIDEO (omxplayer legacy o mpv X11/Wayland/DRM con IPC activo)
    console.log("[PLAYER:VIDEO] Reproduciendo: " + path.basename(fullPath) + (useDrmDirect ? " [DRM]" : "") + (mpvRotateDeg > 0 ? " [rot=" + mpvRotateDeg + "°]" : ""));

    var wallModeOn = isWallActive();
    var playerBin = ((wallModeOn || useDrmDirect) && hasMpv) ? 'mpv' : (hasOmxplayer ? 'omxplayer' : (hasMpv ? 'mpv' : 'omxplayer'));
    var playerArgs = [];

    if (playerBin === 'omxplayer') {
        playerArgs = ['-b', '--no-osd', '--layer', '10000', '--no-keys'];
        if (currentPlaylist.length === 1) playerArgs.push('--loop');
        playerArgs.push(fullPath);
    } else {
        try { if (fs.existsSync(mpvIpcSocketPath)) fs.unlinkSync(mpvIpcSocketPath); } catch (se) {}
        var mpvBaseArgs = [
            '--fs', '--no-osc', '--no-osd-bar', '--really-quiet',
            '--no-input-default-bindings', '--cursor-autohide=always', '--ontop',
            '--hwdec=auto', '--keep-open=no',
            '--scale=bilinear', '--cscale=bilinear', '--dscale=bilinear',
            '--dither-depth=no', '--deband=no',
            '--vd-lavc-fast', '--vd-lavc-skiploopfilter=nonref',
            '--audio-fallback-to-null=yes',
            '--cache=yes', '--demuxer-max-bytes=16M', '--demuxer-max-back-bytes=4M',
            '--framedrop=vo',
            '--input-ipc-server=' + mpvIpcSocketPath
        ];
        if (useDrmDirect) {
            mpvBaseArgs.push('--vo=gpu,drm', '--gpu-context=drm');
        }
        if (mpvRotateDeg > 0) {
            mpvBaseArgs.push('--video-rotate=' + mpvRotateDeg);
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
    watchdogStallCount = 0;
    watchdogLastPos = -1;
    var playStartTime = Date.now();
    var playerStderr = '';
    try {
        var mediaProc = spawn(playerBin, playerArgs, { env: env, stdio: ['ignore', 'ignore', 'pipe'] });
        activePlayerProcess = mediaProc;
        activePlayerBin = playerBin;
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
            activePlayerBin = '';
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
            activePlayerBin = '';
            stopWallSync();
            currentMediaIndex++;
            setTimeout(function () {
                if (token === playbackToken && isPlaying) playCurrentIndex();
            }, 500);
        });
    } catch (e) {
        console.error("[PLAYER EXCEPTION]", e.message);
        if (token !== playbackToken || !isPlaying) return;
        currentMediaIndex++;
        setTimeout(playCurrentIndex, 500);
    }
}

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
        if (cur && cur.idContent) URPNowPlaying = cur.idContent;
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
        convertExistingImages();

        var curWallSig = getWallSignature();
        var videoFiles = diskFiles.filter(function (f) {
            if (!isVideoFile(f) || f.indexOf('.part') !== -1 || f.indexOf('temp_') !== -1) return false;
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

        if (videoFiles.length > 0) {
            var resolvedDiskVideos = [];
            console.log('[STARTUP] ¡' + videoFiles.length + ' video(s) encontrados en disco! Iniciando reproducción continua:');
            for (var p = 0; p < videoFiles.length; p++) {
                var rawDiskPath = path.join(contentBasePath, videoFiles[p]);
                var optDiskPath = getOptimizedVideoPath(rawDiskPath);
                if (optDiskPath && fs.existsSync(optDiskPath)) {
                    try {
                        if (fs.statSync(optDiskPath).size > 4096) {
                            resolvedDiskVideos.push(optDiskPath);
                            continue;
                        }
                    } catch (oe) {}
                }
                if (!/_\d+s\.mp4$/i.test(videoFiles[p])) {
                    scheduleVideoOptimization(rawDiskPath);
                }
                resolvedDiskVideos.push(videoFiles[p]);
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

emergencyDiskPlayback();

// ==============================================================================
// 4. BASE DE DATOS LEVELDB + BACKUP JSON ATOMICO
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
    console.warn('[DB] LevelDB no disponible, usando almacenamiento JSON:', e.message);
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
// 5. UTILIDADES DE ARCHIVOS, CRIPTOGRAFIA Y CONVERSION
// ==============================================================================
var d = require('domain').create();
d.on('error', function (err) {
    var date = new Date();
    if (err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'))
        console.error(convertDate(date) + " connection timeout: " + err.message);
    else
        console.error(convertDate(date) + " domain error caught:", err ? err.message : err);
});

var JSFtp = require('jsftp');
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
    return { key: derived.slice(0, keyLen), iv: derived.slice(keyLen, keyLen + ivLen) };
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

function convertDate(dt) {
    function pad(s) { return (s < 10) ? '0' + s : s; }
    return [dt.getFullYear(), pad(dt.getMonth() + 1), pad(dt.getDate())].join('-');
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
    try { return fs.existsSync(filePath); } catch (e) { return false; }
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
                prebuildAllScheduleBlocks();
            }, 500);
        }
        processNextRender();
    };

    if (!fileExist(file)) return finishJob(false);

    if (fileExist(outPath)) {
        try {
            if (fs.statSync(outPath).size > 4096) return finishJob(true);
            fs.unlinkSync(outPath);
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
        '-nostdin', '-y', '-loglevel', 'error',
        '-loop', '1', '-framerate', '25', '-t', String(duration), '-i', file,
        '-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-vf', vf,
        '-c:v', 'libx264', '-threads', dims.threads, '-preset', 'ultrafast',
        '-profile:v', dims.profile, '-level', dims.level, '-pix_fmt', 'yuv420p',
        '-r', '25', '-vsync', 'cfr', '-g', '25', '-bf', '0',
        '-c:a', 'aac', '-b:a', '128k', '-t', String(duration), '-movflags', '+faststart',
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
                if (stderrLog.length > 2048) stderrLog = stderrLog.slice(-2048);
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
                if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size <= 4096) return finishJob(false);
                if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch (e) {}
                fs.renameSync(tmpPath, outPath);
                console.log('[RENDER] ¡Video MP4 generado!: ' + path.basename(outPath));
                return finishJob(true);
            } catch (err) {
                return finishJob(false);
            }
        });
    } catch (e) {
        if (!finished) {
            finished = true;
            clearTimeout(renderTimeout);
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
            }
            fs.unlinkSync(outPath);
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
        async.eachSeries(images, function (imgFile, next) {
            var baseNoExt = normalizeName(imgFile).replace(/\.[^/.]+$/, "");
            var defaultDuration = 10;
            var scheduleArr = Array.isArray(schedule) ? schedule : [];
            for (var b = 0; b < scheduleArr.length; b++) {
                var blkContents = scheduleArr[b].contents || [];
                for (var c = 0; c < blkContents.length; c++) {
                    if (blkContents[c].content === imgFile || normalizeName(blkContents[c].content) === normalizeName(imgFile)) {
                        var parsedLen = parseInt(blkContents[c].length, 10);
                        if (!isNaN(parsedLen) && parsedLen > 0) defaultDuration = parsedLen;
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
// 5B. OPTIMIZACION AUTOMATICA DE VIDEOS + LIMPIEZA DE HUERFANOS (GARBAGE COLLECTOR)
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

    if (!fs.existsSync(srcPath) || failedOptMap[outPath]) return processNextVideoOpt();
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
            '-vsync', 'cfr',
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
                setTimeout(function () {
                    checkSchedule();
                    prebuildAllScheduleBlocks();
                }, 400);
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

// Garbage Collector de disco: limpia huérfanos fuera de la agenda actual (+ limpieza urgente < 500 MB)
var lastGcAt = 0;
function garbageCollectUnusedMedia(forceEmergency, callback) {
    var result = { removedFiles: 0, freedBytes: 0, emergency: Boolean(forceEmergency) };
    try {
        var scheduleArr = Array.isArray(schedule) ? schedule : [];
        if (scheduleArr.length === 0 && !forceEmergency) {
            if (typeof callback === 'function') callback(result);
            return result;
        }

        var keepFullPaths = {};
        var markKeep = function (p) {
            if (!p) return;
            keepFullPaths[path.resolve(p)] = true;
        };

        for (var fp = 0; fp < filesPlaying.length; fp++) {
            var playF = path.isAbsolute(filesPlaying[fp]) ? filesPlaying[fp] : path.join(contentBasePath, filesPlaying[fp]);
            markKeep(playF);
        }
        if (activeVideoOptOutPath) markKeep(activeVideoOptOutPath);
        if (activeRenderOutPath) markKeep(activeRenderOutPath);

        var wallTagImg = isWallTileActive() ? ('_' + getWallSignature()) : '';
        for (var b = 0; b < scheduleArr.length; b++) {
            var blk = scheduleArr[b];
            var blkItems = blk.contents || [];
            var resolvedBlockItems = [];
            for (var c = 0; c < blkItems.length; c++) {
                var itm = blkItems[c];
                var safeName = normalizeName(itm.content);
                if (!safeName) continue;
                markKeep(path.join(contentBasePath, safeName));
                markKeep(path.join(contentBasePath, itm.content));

                if (isImg(safeName) || isImg(itm.content)) {
                    var dur = parseInt(itm.length, 10);
                    if (isNaN(dur) || dur <= 0) dur = 10;
                    var imgVid = safeName.replace(/\.[^/.]+$/, '') + wallTagImg + '_' + dur + 's.mp4';
                    markKeep(path.join(contentBasePath, imgVid));
                    resolvedBlockItems.push({ file: imgVid, duration: dur });
                } else {
                    var rawPath = path.join(contentBasePath, safeName);
                    var optPath = getOptimizedVideoPath(rawPath);
                    if (optPath) markKeep(optPath);
                    resolvedBlockItems.push({
                        file: (optPath && fs.existsSync(optPath)) ? optPath : safeName,
                        duration: parseInt(itm.length, 10) || 10
                    });
                }
            }
            if (resolvedBlockItems.length > 1) {
                var bHash = computeBlockHash(resolvedBlockItems);
                markKeep(path.join(seamlessBasePath, 'block_' + blk.idScheduleBlock + '_' + bHash + '.mp4'));
            }
        }

        var nowMs = Date.now();
        var orphanAgeThresholdMs = forceEmergency ? 0 : (24 * 3600 * 1000);
        var tempAgeThresholdMs = 2 * 3600 * 1000;

        var scanAndPrune = function (dirPath, isTempDir) {
            if (!fs.existsSync(dirPath)) return;
            var entries = fs.readdirSync(dirPath);
            for (var ei = 0; ei < entries.length; ei++) {
                var fullP = path.resolve(path.join(dirPath, entries[ei]));
                if (keepFullPaths[fullP]) continue;
                try {
                    var st = fs.statSync(fullP);
                    if (!st.isFile()) continue;
                    var ageMs = nowMs - st.mtime.getTime();
                    if (isTempDir || entries[ei].indexOf('temp_') === 0 || /.part$/i.test(entries[ei])) {
                        if (ageMs > tempAgeThresholdMs && !ftpWorking && !isRendering && !isOptimizingVideo && !isConcatenating) {
                            fs.unlinkSync(fullP);
                            result.removedFiles++;
                            result.freedBytes += st.size;
                        }
                    } else if (ageMs >= orphanAgeThresholdMs) {
                        fs.unlinkSync(fullP);
                        result.removedFiles++;
                        result.freedBytes += st.size;
                    }
                } catch (fe) {}
            }
        };

        scanAndPrune(tempFolderPath, true);
        scanAndPrune(optimizedBasePath, false);
        scanAndPrune(seamlessBasePath, false);
        if (scheduleArr.length > 0) {
            scanAndPrune(contentBasePath, false);
        }

        if (result.removedFiles > 0) {
            console.log('[GC:DISCO] Limpieza ' + (forceEmergency ? 'EMERGENCIA' : 'programada') + ': ' + result.removedFiles + ' archivo(s) huérfano(s) eliminado(s), ' + (result.freedBytes / (1024 * 1024)).toFixed(1) + ' MB liberados.');
        }
    } catch (e) {
        console.error('[GC:DISCO] Error:', e.message);
    }
    lastGcAt = Date.now();
    if (typeof callback === 'function') callback(result);
    return result;
}

setTimeout(function () { garbageCollectUnusedMedia(false); }, 90000);
setInterval(function () { garbageCollectUnusedMedia(false); }, 12 * 3600 * 1000);

function fileSerch(contentToSearch, nameToSearch, timeToSearch) {
    var safeContent = normalizeName(contentToSearch);
    var duration = parseInt(timeToSearch, 10);
    if (isNaN(duration) || duration <= 0) duration = 10;

    if (isImg(safeContent) || isImg(contentToSearch)) {
        var baseNoExt = safeContent.replace(/\.[^/.]+$/, "");
        var wallTagImg = isWallTileActive() ? ('_' + getWallSignature()) : '';
        var videoBase = baseNoExt + wallTagImg + '_' + duration + 's';
        var videoName = videoBase + '.mp4';
        var videoPath = contentBasePath + videoName;

        if (fileExist(videoPath)) {
            try {
                if (fs.statSync(videoPath).size > 4096) return videoName;
                fs.unlinkSync(videoPath);
            } catch (e) {}
        }

        var imgSource = fileExist(contentBasePath + safeContent) ? (contentBasePath + safeContent) :
                        (fileExist(contentBasePath + contentToSearch) ? (contentBasePath + contentToSearch) : null);

        if (imgSource) {
            imgToVideo(imgSource, videoBase, duration);
            return path.basename(imgSource);
        } else {
            if (!ftpWorking && respuesta) checkContentsFTP();
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
            if (!ftpWorking && respuesta) checkContentsFTP();
            return false;
        }
    }

    if (isVideoFile(targetPath) && (isArm || isLinux)) {
        var optPath = getOptimizedVideoPath(targetPath);
        if (optPath && fileExist(optPath)) {
            try {
                if (fs.statSync(optPath).size > 4096) return optPath;
                fs.unlinkSync(optPath);
            } catch (e) {}
        }
        scheduleVideoOptimization(targetPath);
    }
    return fileName;
}

// ==============================================================================
// 6. HORARIOS, SEAMLESS LOOP + PRE-CONSTRUCCION ANTICIPADA DE TODOS LOS BLOQUES
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
    var args = ['-v', 'error', '-show_entries', 'format=duration,bit_rate', '-show_entries', 'stream=codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels', '-of', 'json', fullPath];
    var out = '';
    var done = false;
    try {
        var p = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        if (p.stdout) p.stdout.on('data', function (dChunk) { out += dChunk.toString('utf8'); });
        p.on('error', function () { if (!done) { done = true; cb(null); } });
        p.on('close', function (code) {
            if (done) return;
            done = true;
            if (code !== 0 || !out) return cb(null);
            try {
                var parsed = JSON.parse(out);
                var streams = parsed.streams || [];
                var hasVideo = false, hasAudio = false;
                var videoCodec = '', profile = '', pixFmt = '', width = 0, height = 0, fps = 0;
                var audioCodec = '', audioSampleRate = 0, audioChannels = 0;
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
                    fullPath: fullPath, hasVideo: hasVideo, hasAudio: hasAudio, duration: dur, bitRate: bitRate,
                    videoCodec: videoCodec, profile: profile, pixFmt: pixFmt, width: width, height: height, fps: fps,
                    audioCodec: audioCodec, audioSampleRate: audioSampleRate, audioChannels: audioChannels
                });
            } catch (e) { cb(null); }
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

function prebuildAllScheduleBlocks() {
    if (!bootGraceDone || isRendering || isOptimizingVideo || isConcatenating) return;
    var scheduleArr = Array.isArray(schedule) ? schedule : [];
    for (var b = 0; b < scheduleArr.length; b++) {
        var blk = scheduleArr[b];
        var blkItems = blk.contents || [];
        if (blkItems.length < 2) continue;

        var filesToPrebuild = [];
        var allReadyVideos = true;
        for (var c = 0; c < blkItems.length; c++) {
            var itm = blkItems[c];
            var found = fileSerch(itm.content, itm.name, itm.length);
            if (!found || !isVideoFile(found)) {
                allReadyVideos = false;
                break;
            }
            filesToPrebuild.push({
                file: path.isAbsolute(found) ? found : path.basename(found),
                duration: itm.length || 10,
                idContent: itm.idContent || 0
            });
        }
        if (!allReadyVideos || filesToPrebuild.length < 2) continue;

        var hash = computeBlockHash(filesToPrebuild);
        var outPath = seamlessBasePath + 'block_' + blk.idScheduleBlock + '_' + hash + '.mp4';
        if (failedSeamlessHashes[hash] || activeSeamlessHash === hash) continue;
        if (fileExist(outPath)) {
            try {
                if (fs.statSync(outPath).size > 4096) continue;
            } catch (e) {}
        }
        console.log('[PREBUILD] Pre-construyendo bloque horario ' + blk.idScheduleBlock + ' en segundo plano...');
        scheduleSeamlessBuild(blk.idScheduleBlock, hash, filesToPrebuild, outPath);
        break;
    }
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
            failedSeamlessHashes[blockHash] = true;
            isConcatenating = false;
            activeSeamlessHash = '';
            setTimeout(prebuildAllScheduleBlocks, 2000);
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
                   pi.width === targetW && pi.height === targetH &&
                   pi.fps >= 23 && pi.fps <= 26 &&
                   pi.hasAudio && pi.audioCodec === 'aac' &&
                   pi.audioSampleRate === 44100 && pi.audioChannels === 2;
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
                console.log('[SEAMLESS] Unión instantánea (-c copy) para bloque ' + idBlock + ' (' + targetW + 'x' + targetH + ')...');
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
                    filterParts.push('[' + vIdx + ':a]aresample=44100:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo[a' + i + ']');
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
                '-map', '[outv]', '-map', '[outa]',
                '-c:v', 'libx264', '-threads', dims.threads, '-preset', 'ultrafast',
                '-profile:v', dims.profile, '-level', dims.level, '-pix_fmt', 'yuv420p',
                '-r', '25', '-vsync', 'cfr', '-g', '25', '-bf', '0',
                '-crf', dims.crf, '-maxrate', dims.maxRate, '-bufsize', dims.bufSize,
                '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
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
                try { if (ffProc) ffProc.kill('SIGKILL'); } catch (e) {}
                cleanupListFile();
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
                failedSeamlessHashes[blockHash] = true;
                isConcatenating = false;
                activeSeamlessHash = '';
                setTimeout(prebuildAllScheduleBlocks, 2000);
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
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
                failedSeamlessHashes[blockHash] = true;
                isConcatenating = false;
                activeSeamlessHash = '';
                setTimeout(prebuildAllScheduleBlocks, 2000);
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
                    setTimeout(prebuildAllScheduleBlocks, 2000);
                    return;
                }

                try {
                    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
                    fs.renameSync(tmpPath, outPath);
                    cleanupOldSeamless(idBlock, path.basename(outPath));
                    console.log('[SEAMLESS] ¡Loop continuo 0ms listo!: ' + path.basename(outPath) + ' (' + (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2) + ' MB)');
                    setTimeout(function () {
                        checkSchedule();
                        prebuildAllScheduleBlocks();
                    }, 300);
                } catch (e) {
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

    if (filesToPlay.length === 0) {
        console.warn('[PLAY] Bloque ' + idBlock + ' no tiene archivos listos aún en disco.');
        emergencyDiskPlayback();
        playContentRunning = false;
        return;
    }

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

    if (typeof blockToPlay === 'undefined' && maxSchedule > 0) {
        blockToPlay = scheduleArr[0].idScheduleBlock;
        console.log('[SCHEDULE] Usando bloque predeterminado ' + blockToPlay);
    }

    if (typeof blockToPlay !== 'undefined') {
        playContent(blockToPlay);
    } else {
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
// 7. HARDWARE TELEMETRY, DESCARGAS/SUBIDAS FTP Y CONEXION TBEE.TV
// ==============================================================================
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
        var totalMem = osMod.totalmem();
        var freeMem = osMod.freemem();
        if (totalMem > 0) {
            memPercentUsed = Math.round(((totalMem - freeMem) * 100) / totalMem);
        }

        var cpuNow = readProcStatCpu();
        if (cpuNow) {
            if (lastCpuInfo) {
                var diffTotal = cpuNow.total - lastCpuInfo.total;
                var diffIdle = cpuNow.idle - lastCpuInfo.idle;
                if (diffTotal > 0) {
                    cpuUsage = Math.max(0, Math.min(100, Math.round(((diffTotal - diffIdle) * 100) / diffTotal)));
                }
            } else {
                var cpus = osMod.cpus();
                var numCpus = (cpus && cpus.length > 0) ? cpus.length : 4;
                var load1m = osMod.loadavg()[0] || 0;
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

            exec("df -k / | tail -n 1 | awk '{print $4}'", function (err, stdout) {
                if (!err && stdout) {
                    var availKb = parseInt(stdout.toString('utf8').trim(), 10);
                    if (!isNaN(availKb) && availKb > 0) {
                        freeDiskMb = Math.round(availKb / 1024);
                        var availGb = availKb / (1024 * 1024);
                        URPFreeSpace = availGb >= 1 ? (availGb.toFixed(1) + ' GB') : (freeDiskMb + ' MB');
                        if (freeDiskMb < 500 && (Date.now() - lastGcAt) > 600000) {
                            garbageCollectUnusedMedia(true);
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
        var ifaces = osMod.networkInterfaces();
        var fallbackIp = '', preferredIp = '', ethMac = '', wlanMac = '', anyMac = '';

        for (var dev in ifaces) {
            if (!ifaces.hasOwnProperty(dev)) continue;
            if (/^(lo|docker|veth|br-|virbr|tun|tap)/.test(dev)) continue;
            var details = ifaces[dev];
            for (var i = 0; i < details.length; i++) {
                var dIt = details[i];
                if (dIt.family === 'IPv4' && !dIt.internal && dIt.address && dIt.address.indexOf('169.254.') !== 0) {
                    if (/^(eth|en)/.test(dev)) preferredIp = dIt.address;
                    else if (/^(wl|wlan)/.test(dev) && !preferredIp) preferredIp = dIt.address;
                    else if (!fallbackIp) fallbackIp = dIt.address;
                    if (dIt.mac && dIt.mac !== '00:00:00:00:00:00') {
                        if (/^(eth|en)/.test(dev)) ethMac = dIt.mac;
                        else if (/^(wl|wlan)/.test(dev)) wlanMac = dIt.mac;
                        else if (!anyMac) anyMac = dIt.mac;
                    }
                }
            }
        }
        if (!macAdd) macAdd = ethMac || wlanMac || anyMac || '';
        var detectedIp = preferredIp || fallbackIp;

        if (isArm || isLinux) {
            exec("ip -4 route get 8.8.8.8 2>/dev/null", function (err, stdout) {
                var outStr = (!err && stdout) ? stdout.toString('utf8') : '';
                var match = /src\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(outStr);
                var routeIp = (match && match[1]) ? match[1] : '';
                if (routeIp) URPdata.URPIpAddress = routeIp;
                else if (detectedIp) URPdata.URPIpAddress = detectedIp;
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
    if (WSCheckIntervalId != null) clearInterval(WSCheckIntervalId);
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
                if (fileExist(contentBasePath + rawFileName)) localPath = contentBasePath + rawFileName;
                else needsDownload = true;
            }
            if (!needsDownload && itm.md5) {
                if (getFileMD5(localPath) !== itm.md5.toLowerCase()) needsDownload = true;
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
                    if (FTPcontents[q].contentPath === task.contentPath) { inQueue = true; break; }
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
            connectFTP(function () { initQueue(downloadQueue, FTPcontents); });
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
                console.error("[FTP] Error de autenticación (" + ftpUser + "):", err);
            }
        });
    };
    try {
        if (ftp && ftp.raw) try { ftp.raw.quit(); } catch (e) {}
        ftp = new JSFtp({ host: ftpHost, port: parseInt(ftpPort, 10) || 21, user: ftpUser, pass: ftpPass });
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
            console.log('[FTP] Archivo completado: ' + content.contentPath);
        } catch (e) {
            try {
                fs.writeFileSync(content.contentPath, fs.readFileSync(tempPartPath));
                fs.unlinkSync(tempPartPath);
            } catch (e2) {}
        }

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
        setTimeout(prebuildAllScheduleBlocks, 1500);
        if (callback) callback();
    } else {
        console.error("[FTP] MD5 mismatch para " + content.ftpPath);
        if (fs.existsSync(tempPartPath)) try { fs.unlinkSync(tempPartPath); } catch (e) {}
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

    if (fs.existsSync(tempPartPath)) try { fs.unlinkSync(tempPartPath); } catch (e) {}
    var isDone = false, lastBytes = 0, stallChecks = 0, startedAt = Date.now();
    var progressMonitor = setInterval(function () {
        if (isDone) { clearInterval(progressMonitor); return; }
        var curBytes = 0;
        try { if (fs.existsSync(tempPartPath)) curBytes = fs.statSync(tempPartPath).size; } catch (e) {}
        if (curBytes > lastBytes) {
            lastBytes = curBytes;
            stallChecks = 0;
        } else {
            stallChecks++;
        }
        if (stallChecks >= 4 || (Date.now() - startedAt) > 1800000) {
            isDone = true;
            clearInterval(progressMonitor);
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
            if (fs.existsSync(tempPartPath)) try { fs.unlinkSync(tempPartPath); } catch (e) {}
            var idx = getIndex(FTPcontents, content);
            if (idx !== -1) FTPcontents.splice(idx, 1);
            if (callback) callback();
        } else {
            handleDownloadedFile(content, tempPartPath, callback);
        }
    });
}

var downloadFTP = d.bind(function (content, callback) {
    var tempPartPath = content.tempPath + '.part';
    if (fs.existsSync(tempPartPath)) {
        try {
            if ((Date.now() - fs.statSync(tempPartPath).mtime.getTime()) > 3600000) {
                fs.unlinkSync(tempPartPath);
            }
        } catch (e) {}
    }

    if (hasCurl && ftpHost && ftpUser) {
        var remoteRel = content.ftpPath.charAt(0) === '/' ? content.ftpPath.slice(1) : content.ftpPath;
        var encodedPath = remoteRel.split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
        var ftpUrl = 'ftp://' + ftpHost + ':' + (parseInt(ftpPort, 10) || 21) + '/' + encodedPath;

        var startCurlAttempt = function (allowResume) {
            var curlArgs = [
                '--ftp-pasv', '--connect-timeout', '20', '--speed-limit', '1024', '--speed-time', '90',
                '-sS', '-o', tempPartPath, '-u', ftpUser + ':' + (ftpPass || '')
            ];
            if (allowResume && fs.existsSync(tempPartPath)) {
                try { if (fs.statSync(tempPartPath).size > 0) curlArgs.push('-C', '-'); } catch (e) {}
            }
            curlArgs.push(ftpUrl);

            var isDone = false, lastBytes = 0, startedAt = Date.now(), curlErr = '', curlProc = null;
            var progressMonitor = setInterval(function () {
                if (isDone) { clearInterval(progressMonitor); return; }
                var curBytes = 0;
                try { if (fs.existsSync(tempPartPath)) curBytes = fs.statSync(tempPartPath).size; } catch (e) {}
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
                        handleDownloadedFile(content, tempPartPath, callback);
                        return;
                    }
                    if (allowResume && (code === 33 || code === 36)) {
                        try { if (fs.existsSync(tempPartPath)) fs.unlinkSync(tempPartPath); } catch (e) {}
                        return startCurlAttempt(false);
                    }
                    console.warn('[FTP:CURL] Falló (code ' + code + '): ' + (curlErr.trim() || 'sin detalle'));
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

// ==============================================================================
// 7A. SCREENSHOT, UPLOAD LOGS, CLEAN LOGS Y BACKGROUND DESDE TBEE.TV
// ==============================================================================
function callUpdateWS(endpointUrl, value) {
    httpRequest({
        url: endpointUrl,
        method: 'POST',
        json: true,
        timeout: 6000,
        body: { idDisplay: URPdata.idDisplay, value: value }
    }, function () {});
}

function uploadFileViaFtp(localPath, remoteFtpPath, callback) {
    if (!fs.existsSync(localPath) || !ftpHost || !ftpUser) {
        if (typeof callback === 'function') callback(new Error('FTP unavailable'));
        return;
    }
    if (hasCurl) {
        var rel = remoteFtpPath.charAt(0) === '/' ? remoteFtpPath.slice(1) : remoteFtpPath;
        var encoded = rel.split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
        var ftpUrl = 'ftp://' + ftpHost + ':' + (parseInt(ftpPort, 10) || 21) + '/' + encoded;
        var p = spawn('curl', ['--ftp-pasv', '--ftp-create-dirs', '--connect-timeout', '15', '-sS', '-T', localPath, '-u', ftpUser + ':' + (ftpPass || ''), ftpUrl], { stdio: 'ignore' });
        p.on('error', function (e) { if (typeof callback === 'function') callback(e); });
        p.on('close', function (code) {
            if (typeof callback === 'function') callback(code === 0 ? null : new Error('curl upload code=' + code));
        });
        return;
    }
    try {
        var client = new JSFtp({ host: ftpHost, port: parseInt(ftpPort, 10) || 21, user: ftpUser, pass: ftpPass });
        client.put(localPath, remoteFtpPath, function (err) {
            try { if (client && client.raw) client.raw.quit(); } catch (qe) {}
            if (typeof callback === 'function') callback(err || null);
        });
    } catch (e) {
        if (typeof callback === 'function') callback(e);
    }
}

function execUploadLogs(callback) {
    var homeDir = process.env.HOME || '/home/pi';
    var logsPath = fs.existsSync(homeDir + '/.pm2/logs') ? (homeDir + '/.pm2/logs') : '/home/pi/.pm2/logs';
    if (!fs.existsSync(logsPath)) {
        callUpdateWS('http://' + baseUrl + '/ws/updateUploadLogsDisplay.php', 0);
        if (typeof callback === 'function') callback(false);
        return;
    }
    var files = [];
    try { files = fs.readdirSync(logsPath); } catch (e) {}
    var toUpload = files.filter(function (f) {
        try { return fs.statSync(path.join(logsPath, f)).isFile(); } catch (e) { return false; }
    });
    async.eachSeries(toUpload, function (f, next) {
        var fp = path.join(logsPath, f);
        var remote = buildFtpPath(ftpBasePath, URPdata.idCustomer, (URPdata.idZone || 0) + '_' + (URPdata.idStore || 0) + '_' + (URPdata.idURP || 0) + '_' + f);
        uploadFileViaFtp(fp, remote, function () { next(); });
    }, function () {
        callUpdateWS('http://' + baseUrl + '/ws/updateUploadLogsDisplay.php', 0);
        console.log('[LOGS] Logs subidos a tbee.tv (' + toUpload.length + ' archivo(s)).');
        if (typeof callback === 'function') callback(true);
    });
}

function uploadLogs(callback) {
    if (URPdata.isVideoWall && Array.isArray(wall) && wall.length > 0) {
        for (var w = 0; w < wall.length; w++) {
            httpRequest('http://' + wall[w].ip + ':' + wall[w].port + '/uploadLogs', function () {});
        }
    }
    execUploadLogs(callback);
}

function execCleanLogs() {
    if (isArm || isLinux) {
        exec("pm2 flush 2>/dev/null || true", function () {});
    }
    recentLogs = [];
    console.log('[LOGS] Logs locales limpiados.');
}

function cleanLogs() {
    if (URPdata.isVideoWall && Array.isArray(wall) && wall.length > 0) {
        for (var w = 0; w < wall.length; w++) {
            httpRequest('http://' + wall[w].ip + ':' + wall[w].port + '/cleanLogs', function () {});
        }
    }
    execCleanLogs();
}

function captureMpvFrame(outPath, callback) {
    if (!isPlaying || !activePlayerProcess || activePlayerBin !== 'mpv' || !fs.existsSync(mpvIpcSocketPath)) {
        return callback(false);
    }
    var tmpOut = outPath + '.mpv.jpg';
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (e) {}
    mpvIpcRequest([['screenshot-to-file', tmpOut, 'video']], function (err, res) {
        var r1 = res && res[1];
        if (!err && r1 && r1.error === 'success' && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 512) {
            try {
                fs.renameSync(tmpOut, outPath);
                return callback(true);
            } catch (re) {}
        }
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (ue) {}
        callback(false);
    });
}

function captureOsDisplayFrame(outPath, callback) {
    var env = getGuiEnv();
    var cmd = '';
    if (hasWaylandDisplay && hasGrim) {
        cmd = 'grim -t jpeg -q 80 "' + outPath + '"';
    } else if (hasX11Display && hasScrot) {
        cmd = 'scrot -q 80 -o "' + outPath + '"';
    } else if (hasRaspi2png) {
        cmd = 'raspi2png -p "' + outPath + '"';
    } else if (hasX11Display) {
        cmd = 'ffmpeg -nostdin -y -loglevel error -f x11grab -i :0.0 -frames:v 1 "' + outPath + '"';
    } else {
        cmd = 'ffmpeg -nostdin -y -loglevel error -f fbdev -i /dev/fb0 -frames:v 1 "' + outPath + '"';
    }
    exec(cmd, { env: env, timeout: 8000 }, function (err) {
        var ok = !err && fs.existsSync(outPath) && fs.statSync(outPath).size > 512;
        callback(ok);
    });
}

var livePreviewBusy = false;
var livePreviewWaiters = [];
function captureLivePreview(callback) {
    var outPreview = basePath + 'live_preview.jpg';
    if (!isArm && !isLinux) {
        if (typeof callback === 'function') callback(false, outPreview);
        return;
    }
    if (typeof callback === 'function') livePreviewWaiters.push(callback);
    if (livePreviewBusy) return;
    livePreviewBusy = true;

    var done = function (ok) {
        livePreviewBusy = false;
        var list = livePreviewWaiters.slice();
        livePreviewWaiters = [];
        for (var wi = 0; wi < list.length; wi++) {
            try { list[wi](ok, outPreview); } catch (e) {}
        }
    };

    var tmpPreview = basePath + 'live_preview.tmp.jpg';
    try { if (fs.existsSync(tmpPreview)) fs.unlinkSync(tmpPreview); } catch (e) {}

    captureMpvFrame(tmpPreview, function (mpvOk) {
        if (mpvOk && fs.existsSync(tmpPreview)) {
            try {
                fs.renameSync(tmpPreview, outPreview);
                return done(true);
            } catch (re) {}
        }
        captureOsDisplayFrame(tmpPreview, function (osOk) {
            if (osOk && fs.existsSync(tmpPreview)) {
                try {
                    fs.renameSync(tmpPreview, outPreview);
                    return done(true);
                } catch (re2) {}
            }
            try { if (fs.existsSync(tmpPreview)) fs.unlinkSync(tmpPreview); } catch (ue) {}
            done(fs.existsSync(outPreview) && fs.statSync(outPreview).size > 512);
        });
    });
}

function getTailscaleIp() {
    try {
        var ifaces = osMod.networkInterfaces();
        var keys = Object.keys(ifaces || {});
        for (var i = 0; i < keys.length; i++) {
            var name = keys[i];
            var list = ifaces[name] || [];
            for (var j = 0; j < list.length; j++) {
                var item = list[j];
                if (!item || item.internal || item.family !== 'IPv4') continue;
                if (name.indexOf('tailscale') !== -1 || /^100.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])./.test(item.address)) {
                    return item.address;
                }
            }
        }
    } catch (e) {}
    return '';
}

function execScreenshot(callback) {
    var outShot = basePath + 'screenshot.jpg';
    if (!isArm && !isLinux) {
        if (typeof callback === 'function') callback(false, outShot);
        return;
    }
    var finishShot = function (ok) {
        if (ok && ftpHost && ftpUser) {
            var nowD = new Date();
            var timeTag = nowD.toTimeString().slice(0, 8).replace(/:/g, '-');
            var remote = buildFtpPath(ftpBasePath, URPdata.idCustomer, (URPdata.idZone || 0) + '_' + (URPdata.idStore || 0) + '_' + (URPdata.idURP || 0) + '_' + convertDate(nowD) + '_' + timeTag + '_screenshot.jpg');
            uploadFileViaFtp(outShot, remote, function () {
                callUpdateWS('http://' + baseUrl + '/ws/updateScreenshotDisplay.php', 0);
                if (typeof callback === 'function') callback(true, outShot);
            });
        } else {
            callUpdateWS('http://' + baseUrl + '/ws/updateScreenshotDisplay.php', 0);
            if (typeof callback === 'function') callback(ok, outShot);
        }
    };

    captureMpvFrame(outShot, function (mpvOk) {
        if (mpvOk) return finishShot(true);
        captureOsDisplayFrame(outShot, function (osOk) {
            finishShot(osOk);
        });
    });
}

function takeScreenshot(callback) {
    if (URPdata.isVideoWall && Array.isArray(wall) && wall.length > 0) {
        for (var w = 0; w < wall.length; w++) {
            httpRequest('http://' + wall[w].ip + ':' + wall[w].port + '/screenshot', function () {});
        }
    }
    execScreenshot(callback);
}

function downloadBackgroundFile() {
    if (!URPdata.idCustomer) return;
    var bgUrl = 'http://' + baseUrl + '/content/' + URPdata.idCustomer + '/background.png';
    var bgPath = basePath + 'background.png';
    httpRequest({ url: bgUrl, encoding: null, timeout: 15000 }, function (err, res, body) {
        if (!err && res && res.statusCode === 200 && body && body.length > 256) {
            try {
                fs.writeFileSync(bgPath + '.tmp', body);
                fs.renameSync(bgPath + '.tmp', bgPath);
                console.log('[BG] background.png actualizado (' + body.length + ' bytes).');
            } catch (e) {}
        }
    });
}

// ==============================================================================
// 7B. OTA SERVIDOR + OTA GITHUB CON ROLLBACK AUTOMATICO (.ota_pending)
// ==============================================================================
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

function writeOtaPendingMarker(targetPath, backupPath, version) {
    try {
        fs.writeFileSync(otaPendingPath, JSON.stringify({
            ts: Date.now(),
            version: version,
            targetPath: targetPath,
            backupPath: backupPath
        }), 'utf8');
    } catch (e) {}
}

function checkURPVersion(remoteVersion, remoteMD5) {
    if (URPUpdated || isUpdatingCode) return;
    if (!isNewerVersion(remoteVersion, URPVersion)) return;

    isUpdatingCode = true;
    var scriptName = path.basename(__filename) || (URPType + '.js');
    var updateUrl = 'http://' + baseUrl + '/URP/' + scriptName;
    var tempNewPath = tempFolderPath + scriptName + '.new.js';
    var targetPath = __filename || (basePath + scriptName);
    var backupPath = targetPath + '.bak';

    httpRequest({ url: updateUrl, encoding: null, timeout: 20000 }, function (err, res, body) {
        if (err || !res || res.statusCode !== 200 || !body || body.length < 5000) {
            isUpdatingCode = false;
            return;
        }
        var downloadedMd5 = crypto.createHash('md5').update(body).digest('hex').toLowerCase();
        if (remoteMD5 && String(remoteMD5).trim().length === 32 && downloadedMd5 !== String(remoteMD5).trim().toLowerCase()) {
            isUpdatingCode = false;
            return;
        }
        try {
            fs.writeFileSync(tempNewPath, body);
            execSync('node --check "' + tempNewPath + '"', { stdio: 'ignore' });
        } catch (chkErr) {
            try { if (fs.existsSync(tempNewPath)) fs.unlinkSync(tempNewPath); } catch (e) {}
            isUpdatingCode = false;
            return;
        }
        try {
            if (fs.existsSync(targetPath)) {
                try { fs.writeFileSync(backupPath, fs.readFileSync(targetPath)); } catch (be) {}
            }
            try { fs.renameSync(tempNewPath, targetPath); } catch (re) {
                fs.writeFileSync(targetPath, fs.readFileSync(tempNewPath));
                fs.unlinkSync(tempNewPath);
            }
            writeOtaPendingMarker(targetPath, backupPath, remoteVersion);
            URPUpdated = true;
            isUpdatingCode = false;
            stopOmx(function () {
                exec('pm2 restart all 2>/dev/null || true', function () {
                    setTimeout(function () { process.exit(0); }, 500);
                });
            });
        } catch (applyErr) {
            isUpdatingCode = false;
        }
    });
}

var GITHUB_OTA_ENABLED = true;
var GITHUB_OTA_REPO = 'JulianDS95/URPSignageTv';
var GITHUB_OTA_BRANCH = 'main';
var GITHUB_OTA_INTERVAL_MS = 300000;
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
    httpRequest({ url: wallShUrl, headers: headers, encoding: 'utf8', timeout: 15000 }, function (err, res, body) {
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
    var scriptName = path.basename(__filename) || 'URPPI3-v2.5.js';
    var targetPath = __filename || (basePath + scriptName);
    var backupPath = targetPath + '.bak';
    var localMd5 = getFileMD5(targetPath);
    var ghUrl = 'https://raw.githubusercontent.com/' + GITHUB_OTA_REPO + '/' + branch + '/' + scriptName + '?t=' + Date.now();
    var token = getGithubOtaToken();

    var headers = {
        'User-Agent': 'URP-Signage-Client/' + URPVersion,
        'Cache-Control': 'no-cache'
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    isUpdatingCode = true;
    httpRequest({ url: ghUrl, headers: headers, encoding: null, timeout: 20000 }, function (err, res, body) {
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
        var tempNewPath = tempFolderPath + scriptName + '.github.new.js';

        try {
            if (!fs.existsSync(tempFolderPath)) fs.mkdirSync(tempFolderPath);
            fs.writeFileSync(tempNewPath, body);
            execSync('node --check "' + tempNewPath + '"', { stdio: 'ignore' });
        } catch (chkErr) {
            lastFailedGithubMd5 = downloadedMd5;
            try { if (fs.existsSync(tempNewPath)) fs.unlinkSync(tempNewPath); } catch (e) {}
            isUpdatingCode = false;
            if (manualCallback) manualCallback({ updated: false, reason: 'syntax_error' });
            return;
        }

        try {
            if (fs.existsSync(targetPath)) {
                try { fs.writeFileSync(backupPath, fs.readFileSync(targetPath)); } catch (be) {}
            }
            try { fs.renameSync(tempNewPath, targetPath); } catch (re) {
                fs.writeFileSync(targetPath, fs.readFileSync(tempNewPath));
                fs.unlinkSync(tempNewPath);
            }
            try { fs.chmodSync(targetPath, '755'); } catch (ce) {}
            writeOtaPendingMarker(targetPath, backupPath, remoteVersion);

            URPUpdated = true;
            isUpdatingCode = false;
            console.log('[OTA:GITHUB] Actualización aplicada (v' + remoteVersion + '). Reiniciando con rollback protegido...');
            syncCompanionWallScript(branch, headers);
            if (manualCallback) manualCallback({ updated: true, version: remoteVersion });

            stopOmx(function () {
                exec('pm2 restart URP 2>/dev/null || pm2 restart all 2>/dev/null || true', function () {
                    setTimeout(function () { process.exit(0); }, 500);
                });
            });
        } catch (applyErr) {
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

            httpRequest(options, function (err, httpResponse, data) {
                if (!err && httpResponse && httpResponse.statusCode == 200) {
                    respuesta = true;
                    if (data && typeof data === 'object') {
                        if (data.reboot === 1 || data.reboot === '1') {
                            httpRequest({
                                url: 'http://' + baseUrl + '/ws/updateRebootDisplay.php',
                                method: 'POST',
                                json: true,
                                timeout: 5000,
                                body: { idDisplay: data.idDisplay || URPdata.idDisplay, reboot: 0 }
                            }, function () { resetURP(); });
                            return;
                        }
                        if (data.shutdown === 1 || data.shutdown === '1') {
                            httpRequest({
                                url: 'http://' + baseUrl + '/ws/updateShutdownDisplay.php',
                                method: 'POST',
                                json: true,
                                timeout: 3000,
                                body: { idDisplay: data.idDisplay || URPdata.idDisplay, shutdown: 0 }
                            }, function () { shutdownURP(); });
                            return;
                        }
                        if (data.deleteContents === 1 || data.deleteContents === '1' || data.deleteContent === 1 || data.deleteContent === '1') {
                            deleteContentFiles();
                        }

                        if (!URPUpdated && data.URPVersion) checkURPVersion(data.URPVersion, data.URPCodeMD5);

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
                            console.log('[VIDEOWALL:REMOTO] tbee.tv cambió Video Wall -> ' + (nextWallActive ? 'ACTIVADO' : 'DESACTIVADO'));
                            stopOmx(function () { setTimeout(function () { checkSchedule(); }, 300); });
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

                        if (data.cleanLogs == 1 || data.cleanLogs === '1') cleanLogs();
                        if (data.uploadLogs == 1 || data.uploadLogs === '1') uploadLogs();
                        if (data.screenshot == 1 || data.screenshot === '1') takeScreenshot();
                        if (data.background == 1 || data.background === '1') downloadBackgroundFile();

                        if (data.blocks != undefined) {
                            if (data.blocks.length > 0) {
                                var newBlocksStr = JSON.stringify(data.blocks);
                                var oldBlocksStr = JSON.stringify(schedule);
                                if (newBlocksStr !== oldBlocksStr) {
                                    console.log("[SCHEDULE] Nueva programación recibida (" + data.blocks.length + " bloques).");
                                    schedule = data.blocks;
                                    if (db) db.put('schedule', newBlocksStr);
                                    checkContentsFTP();
                                    checkSchedule();
                                    setTimeout(prebuildAllScheduleBlocks, 2000);
                                } else {
                                    checkContentsFTP();
                                }
                            } else {
                                schedule = [];
                                contents = [];
                                max = 0;
                                blockPlaying = 0;
                                URPNowPlaying = 0;
                                if (db) {
                                    db.del('schedule', function () {});
                                    db.del('contents', function () {});
                                }
                                stopOmx(function () { setBackground(); });
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
            } catch (err) {}
        }
    } catch (e) {}
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
        if (typeof callback === 'function') callback();
    });
}

function deleteContentFiles(callback) {
    if (URPdata.isVideoWall && Array.isArray(wall) && wall.length > 0) {
        for (var w = 0; w < wall.length; w++) {
            httpRequest('http://' + wall[w].ip + ':' + wall[w].port + '/deleteContents', function () {});
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
            httpRequest('http://' + wall[w].ip + ':' + wall[w].port + '/reboot', function () {});
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
            httpRequest('http://' + wall[w].ip + ':' + wall[w].port + '/shutdown', function () {});
        }
        setTimeout(shutdownDevice, 45000);
    } else {
        shutdownDevice();
    }
}

// ==============================================================================
// 8. MINI PANEL WEB LOCAL + CONFIGURADOR VIDEO WALL + API HTTP (:8090)
// ==============================================================================
function writeHdmiRotateToConfig(rot) {
    if (!isArm && !isLinux) return { ok: false, reason: 'No es Raspberry/Linux' };
    var cfg = fs.existsSync('/boot/firmware/config.txt')
        ? '/boot/firmware/config.txt'
        : (fs.existsSync('/boot/config.txt') ? '/boot/config.txt' : '');
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
        var content = outLines.join('\n');
        var tmpFile = '/tmp/urp_config_' + Date.now() + '.txt';
        fs.writeFileSync(tmpFile, content, 'utf8');
        try {
            execSync('sudo -n cp "' + tmpFile + '" "' + cfg + '" && rm -f "' + tmpFile + '"', { stdio: 'ignore', timeout: 4000 });
            return { ok: true, path: cfg };
        } catch (se) {
            try {
                fs.writeFileSync(cfg, content, 'utf8');
                try { fs.unlinkSync(tmpFile); } catch (ue) {}
                return { ok: true, path: cfg };
            } catch (we) {
                try { fs.unlinkSync(tmpFile); } catch (ue2) {}
                return { ok: false, reason: 'Sin permisos sudo sin clave para editar ' + cfg + ' (ejecutá urp-wall desde SSH para aplicar HDMI rotate)' };
            }
        }
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

function clearWallDerivedCaches() {
    failedSeamlessHashes = {};
    clearDirectoryFiles(optimizedBasePath);
    clearDirectoryFiles(seamlessBasePath);
    try {
        if (fs.existsSync(contentBasePath)) {
            var cfiles = fs.readdirSync(contentBasePath);
            for (var i = 0; i < cfiles.length; i++) {
                if (/_W[TM][^_]*_.*_\d+s\.mp4$/i.test(cfiles[i]) || /_WM_\d+s\.mp4$/i.test(cfiles[i])) {
                    try { fs.unlinkSync(path.join(contentBasePath, cfiles[i])); } catch (e) {}
                }
            }
        }
    } catch (e) {}
}

function readJsonBody(req, callback) {
    if (req.body && typeof req.body === 'object') {
        return callback(null, req.body);
    }
    var raw = '';
    var aborted = false;
    req.on('data', function (chunk) {
        raw += chunk;
        if (raw.length > 65536 && !aborted) {
            aborted = true;
            callback(new Error('Body demasiado grande'));
        }
    });
    req.on('end', function () {
        if (aborted) return;
        try {
            callback(null, raw ? JSON.parse(raw) : {});
        } catch (e) {
            callback(e);
        }
    });
    req.on('error', function (err) {
        if (!aborted) {
            aborted = true;
            callback(err);
        }
    });
}

function buildLocalDashboardHtml() {
    return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>URP Signage Monitor v' + URPVersion + '</title>' +
        '<style>' +
        '*{box-sizing:border-box}' +
        'body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#090d16;color:#e2e8f0;padding:18px}' +
        '.wrap{max-width:1040px;margin:0 auto}' +
        '.top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}' +
        'h1{margin:0;font-size:19px;color:#fff} h2{margin:0 0 8px 0;font-size:16px;color:#fff} .sub{font-size:12px;color:#94a3b8}' +
        '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:14px}' +
        '.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:14px;margin-bottom:14px}' +
        '.k{font-size:11px;text-transform:uppercase;color:#94a3b8;margin-bottom:4px;letter-spacing:.04em}' +
        '.v{font-size:18px;font-weight:700;color:#fff}' +
        '.btns{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}' +
        'button{border:0;border-radius:8px;padding:9px 13px;font-size:12px;font-weight:600;cursor:pointer;color:#fff;background:#1e293b;transition:filter .15s}' +
        'button:hover{filter:brightness(1.15)} .b-blue{background:#2563eb}.b-indigo{background:#4f46e5}.b-amber{background:#d97706}.b-red{background:#dc2626}.b-green{background:#059669}.b-ghost{background:#0f172a;border:1px solid #334155}' +
        'pre{background:#030712;border:1px solid #1f2937;border-radius:10px;padding:12px;font-size:11px;line-height:1.45;max-height:290px;overflow:auto;color:#cbd5e1;margin:0}' +
        '.shot{max-width:100%;max-height:460px;object-fit:contain;border-radius:8px;border:1px solid #1f2937;background:#020617;display:block;margin:8px auto 0 auto}' +
        '.pbarWrap{height:6px;background:#030712;border-radius:99px;overflow:hidden;margin-top:7px;border:1px solid #1f2937}' +
        '.pbarFill{height:100%;width:0%;background:#3b82f6;transition:width .4s ease}' +
        '.liveHead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}' +
        '.liveBadge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;letter-spacing:.05em;background:#1e293b;color:#94a3b8}' +
        '.liveBadge.on{background:#065f46;color:#6ee7b7}' +
        '.hide{display:none!important}' +
        '.msg{padding:10px 12px;border-radius:9px;font-size:12px;margin-bottom:14px;border:1px solid #1e40af;background:#0f172a;color:#bfdbfe;display:none}' +
        '.msg.err{border-color:#991b1b;background:#1f1215;color:#fecaca} .msg.ok{border-color:#065f46;background:#091f18;color:#a7f3d0}' +
        '.fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-bottom:12px}' +
        'label.lbl{display:block;font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:5px}' +
        'select,input[type=number],input[type=text]{width:100%;background:#030712;border:1px solid #334155;border-radius:8px;padding:8px 10px;color:#f8fafc;font-size:13px}' +
        '.stepRow{display:flex;gap:6px;align-items:center} .stepRow button{min-width:36px;padding:8px 10px}' +
        '.presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px} .pbtn{padding:6px 10px;font-size:11px;background:#0f172a;border:1px solid #334155}' +
        '.pbtn.on{background:#2563eb;border-color:#3b82f6}' +
        '.mwrap{overflow-x:auto;padding:8px 0}' +
        '.mgrid{display:inline-grid;gap:6px;background:#030712;padding:10px;border-radius:10px;border:1px solid #1f2937}' +
        '.mcell{min-width:54px;height:42px;border-radius:7px;border:1px solid #334155;background:#111827;color:#cbd5e1;font-size:11px;font-weight:700;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer}' +
        '.mcell small{font-size:9px;font-weight:400;color:#64748b} .mcell.active{background:#2563eb;border-color:#60a5fa;color:#fff} .mcell.active small{color:#dbeafe}' +
        '.warnBox{padding:9px 11px;border-radius:8px;background:#291d09;border:1px solid #b45309;color:#fde68a;font-size:12px;margin-top:8px;display:none;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}' +
        '.chkRow{display:flex;align-items:center;gap:8px;font-size:13px;color:#e2e8f0;padding-top:6px}' +
        '</style></head><body><div class="wrap">' +
        '<div class="top"><div><h1>URP Signage Monitor <span id="ver"></span></h1><div class="sub" id="meta">Cargando...</div></div>' +
        '<div class="sub" id="conn"></div></div>' +
        '<div id="msgBox" class="msg"></div>' +

        '<div id="viewMonitor">' +
        '<div class="grid" style="margin-bottom:0">' +
        '<div class="card"><div class="k">Reproduciendo</div><div class="v" id="now" style="font-size:13px;word-break:break-all">-</div><div class="pbarWrap"><div id="pbar" class="pbarFill"></div></div><div class="sub" id="ptime" style="margin-top:4px">-</div></div>' +
        '<div class="card"><div class="k">CPU / RAM / Temp</div><div class="v" id="hw">-</div></div>' +
        '<div class="card"><div class="k">Disco Libre</div><div class="v" id="disk">-</div></div>' +
        '<div class="card"><div class="k">Video Wall</div><div class="v" id="vw" style="font-size:13px">-</div></div>' +
        '</div>' +
        '<div class="btns">' +
        '<button id="btnOpenWall" class="b-indigo">Configurar Video Wall</button>' +
        '<button id="btnRestartPlayer" class="b-amber">Reiniciar Reproductor</button>' +
        '<button id="btnUpdate" class="b-blue">Buscar OTA GitHub</button>' +
        '<button id="btnGc" class="b-green">Limpiar Huérfanos</button>' +
        '<button id="btnCleanLogs">Limpiar Logs</button>' +
        '<button id="btnReboot" class="b-amber">Reiniciar Pi</button>' +
        '<button id="btnShutdown" class="b-red">Apagar Pi</button>' +
        '<button id="btnDelete" class="b-red">Borrar Contenidos</button>' +
        '</div>' +
        '<div class="card"><div class="liveHead">' +
        '<div><span class="k" style="margin-right:8px">Monitor Visual en Vivo</span><span id="liveBadge" class="liveBadge">PAUSADO</span><div class="sub" id="liveMeta" style="margin-top:2px">Activá Vista en Vivo para supervisar la pantalla desde cualquier ubicación (sin subir al FTP)</div></div>' +
        '<div class="btns" style="margin:0">' +
        '<select id="liveInt" style="width:auto;padding:7px 9px;font-size:12px"><option value="2000">Cada 2s</option><option value="3000" selected>Cada 3s</option><option value="5000">Cada 5s</option></select>' +
        '<button id="btnToggleLive" class="b-green">Activar Vista en Vivo</button>' +
        '<button id="btnShot">Capturar Ahora</button>' +
        '</div></div>' +
        '<div id="liveEmpty" class="sub" style="padding:18px;text-align:center;border:1px dashed #334155;border-radius:8px;margin-top:6px">Sin captura cargada todavía. Pulsá &ldquo;Capturar Ahora&rdquo; o &ldquo;Activar Vista en Vivo&rdquo;.</div>' +
        '<img id="shotImg" class="shot" style="display:none" alt="Vista previa pantalla">' +
        '</div>' +
        '<div class="card"><div class="k">Colas y Agenda</div><div id="queues" class="sub" style="margin-top:4px">-</div></div>' +
        '<div class="card"><div class="k">Logs en vivo</div><pre id="logs">Cargando...</pre></div>' +
        '</div>' +

        '<div id="viewWall" class="hide">' +
        '<div class="top" style="margin-bottom:12px">' +
        '<div><h2>Configurador de Video Wall</h2><div class="sub" id="vwSub">Sin límite de 3 pantallas: soporta IDs 1..999 y matrices hasta 32x32</div></div>' +
        '<button id="btnBackWall" class="b-ghost">&larr; Volver atrás</button>' +
        '</div>' +

        '<div class="card">' +
        '<div class="fgrid">' +
        '<div><label class="lbl" for="wAct">Activación</label><select id="wAct">' +
        '<option value="server">Remoto desde tbee.tv (sigue check del servidor)</option>' +
        '<option value="local_on">Siempre ACTIVO (Local en esta Pi)</option>' +
        '<option value="local_off">DESACTIVADO (Modo Normal URPPI3)</option>' +
        '</select></div>' +
        '<div><label class="lbl" for="wMode">Modo de proyección</label><select id="wMode">' +
        '<option value="tile">Mosaico / Imagen partida (tile)</option>' +
        '<option value="mirror">Espejo sincronizado (mirror)</option>' +
        '</select></div>' +
        '<div><label class="lbl" for="wScreenId">ID de esta Pantalla (1 - 999)</label>' +
        '<div class="stepRow"><button type="button" id="btnIdMinus">-</button>' +
        '<input type="number" id="wScreenId" min="1" max="999" value="1">' +
        '<button type="button" id="btnIdPlus">+</button></div></div>' +
        '</div>' +

        '<div class="k" style="margin-top:6px">Disposición rápida</div>' +
        '<div id="wPresets" class="presets">' +
        '<button type="button" class="pbtn" data-r="1" data-c="2">1x2</button>' +
        '<button type="button" class="pbtn" data-r="1" data-c="3">1x3</button>' +
        '<button type="button" class="pbtn" data-r="1" data-c="4">1x4</button>' +
        '<button type="button" class="pbtn" data-r="1" data-c="5">1x5</button>' +
        '<button type="button" class="pbtn" data-r="1" data-c="6">1x6</button>' +
        '<button type="button" class="pbtn" data-r="2" data-c="1">2x1</button>' +
        '<button type="button" class="pbtn" data-r="2" data-c="2">2x2</button>' +
        '<button type="button" class="pbtn" data-r="2" data-c="3">2x3</button>' +
        '<button type="button" class="pbtn" data-r="3" data-c="3">3x3</button>' +
        '</div>' +

        '<div class="fgrid">' +
        '<div><label class="lbl" for="wRows">Filas (1 - 32)</label><input type="number" id="wRows" min="1" max="32" value="1"></div>' +
        '<div><label class="lbl" for="wCols">Columnas (1 - 32)</label><input type="number" id="wCols" min="1" max="32" value="3"></div>' +
        '<div><label class="lbl" for="wBezel">Bisel / Marco físico (px)</label><input type="number" id="wBezel" min="0" max="400" value="0"></div>' +
        '</div>' +

        '<div class="fgrid">' +
        '<div><label class="lbl" for="wOrient">Orientación HDMI</label><select id="wOrient">' +
        '<option value="0">0° Horizontal Normal</option>' +
        '<option value="1">90° Vertical Derecha</option>' +
        '<option value="2">180° Invertido</option>' +
        '<option value="3">270° Vertical Izquierda</option>' +
        '</select></div>' +
        '<div><label class="lbl" for="wSync">Sincronización</label><select id="wSync">' +
        '<option value="ntp">NTP automático (sin Master)</option>' +
        '<option value="master">Master LAN (esta Pi es reloj :8090)</option>' +
        '<option value="slave">Slave LAN (seguir IP de Master)</option>' +
        '</select></div>' +
        '<div id="wMasterWrap"><label class="lbl" for="wMasterIp">IP del Master LAN</label><input type="text" id="wMasterIp" placeholder="Ej: 192.168.1.50"></div>' +
        '</div>' +

        '<label class="chkRow"><input type="checkbox" id="wDrm"> Salida DRM/KMS directa (forzar mpv sin X11/Wayland)</label>' +

        '<div id="wWarn" class="warnBox"><span id="wWarnTxt"></span><button type="button" id="btnAutoExpand" class="b-amber">Ajustar matriz a 1&times;ID</button></div>' +
        '<div style="margin-top:12px"><div class="k" id="wMatrixLabel">Vista de matriz (clic para elegir posición)</div><div class="mwrap"><div id="wMatrix" class="mgrid"></div></div></div>' +
        '</div>' +

        '<div class="btns">' +
        '<button type="button" id="btnCancelWall" class="b-ghost">&larr; Volver sin guardar</button>' +
        '<button type="button" id="btnResetWall">Restaurar guardado</button>' +
        '<button type="button" id="btnSaveWall" class="b-green">Guardar y Aplicar</button>' +
        '</div>' +
        '</div>' +

        '</div><script>' +
        'var lastStatus = null;' +
        'var wallLoaded = false;' +
        'var liveActive = false;' +
        'var liveTimer = null;' +
        'var liveInFlight = false;' +
        'var nl = String.fromCharCode(10);' +
        'function byId(id){ return document.getElementById(id); }' +
        'function fmtSec(sec){' +
        '  var s = Math.max(0, Math.floor(sec || 0));' +
        '  var m = Math.floor(s / 60);' +
        '  var r = s % 60;' +
        '  return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r;' +
        '}' +
        'function showMsg(txt, kind){' +
        '  var m = byId("msgBox");' +
        '  if (!txt) { m.style.display = "none"; m.className = "msg"; return; }' +
        '  m.textContent = txt;' +
        '  m.className = "msg " + (kind || "");' +
        '  m.style.display = "block";' +
        '}' +
        'function clampInt(val, min, max, fallback){' +
        '  var n = parseInt(val, 10);' +
        '  if (isNaN(n)) return fallback;' +
        '  return Math.max(min, Math.min(max, n));' +
        '}' +
        'function scheduleLiveNext(){' +
        '  if (!liveActive) return;' +
        '  if (liveTimer) clearTimeout(liveTimer);' +
        '  var ms = clampInt(byId("liveInt").value, 1000, 30000, 3000);' +
        '  liveTimer = setTimeout(fetchLiveFrame, ms);' +
        '}' +
        'function fetchLiveFrame(){' +
        '  if (liveInFlight) return;' +
        '  liveInFlight = true;' +
        '  var img = byId("shotImg");' +
        '  img.onload = function(){' +
        '    liveInFlight = false;' +
        '    byId("liveEmpty").style.display = "none";' +
        '    img.style.display = "block";' +
        '    byId("liveMeta").textContent = "Último frame capturado: " + new Date().toLocaleTimeString();' +
        '    scheduleLiveNext();' +
        '  };' +
        '  img.onerror = function(){' +
        '    liveInFlight = false;' +
        '    byId("liveMeta").textContent = "Sin frame disponible aún (esperando reproductor...)";' +
        '    scheduleLiveNext();' +
        '  };' +
        '  img.src = "/api/preview.jpg?t=" + Date.now();' +
        '}' +
        'function setLiveMode(on){' +
        '  liveActive = Boolean(on);' +
        '  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }' +
        '  var b = byId("liveBadge");' +
        '  var btn = byId("btnToggleLive");' +
        '  if (liveActive) {' +
        '    b.textContent = "EN VIVO";' +
        '    b.className = "liveBadge on";' +
        '    btn.textContent = "Pausar Vista en Vivo";' +
        '    btn.className = "b-amber";' +
        '    fetchLiveFrame();' +
        '  } else {' +
        '    b.textContent = "PAUSADO";' +
        '    b.className = "liveBadge";' +
        '    btn.textContent = "Activar Vista en Vivo";' +
        '    btn.className = "b-green";' +
        '  }' +
        '}' +
        'function syncToForm(cfg, serverFlag){' +
        '  if (!cfg) return;' +
        '  byId("wAct").value = cfg.activationMode === "server" ? "server" : (cfg.enabled ? "local_on" : "local_off");' +
        '  byId("wMode").value = cfg.mode === "mirror" ? "mirror" : "tile";' +
        '  byId("wRows").value = clampInt(cfg.rows, 1, 32, 1);' +
        '  byId("wCols").value = clampInt(cfg.cols, 1, 32, 3);' +
        '  byId("wScreenId").value = clampInt(cfg.screenId, 1, 999, 1);' +
        '  byId("wBezel").value = clampInt(cfg.bezelPx, 0, 400, 0);' +
        '  byId("wOrient").value = String(clampInt(cfg.orientation, 0, 3, 0));' +
        '  if (cfg.syncMode === "master" && cfg.masterIp) { byId("wSync").value = "slave"; }' +
        '  else if (cfg.syncMode === "master") { byId("wSync").value = "master"; }' +
        '  else { byId("wSync").value = "ntp"; }' +
        '  byId("wMasterIp").value = cfg.masterIp || "";' +
        '  byId("wDrm").checked = Boolean(cfg.drmMode);' +
        '  byId("vwSub").textContent = "Control tbee.tv ahora: " + (serverFlag ? "ACTIVO" : "DESACTIVADO") + " | Soporta IDs 1..999 y matrices hasta 32x32";' +
        '  updateWallPreview();' +
        '}' +
        'function updateWallPreview(){' +
        '  var rows = clampInt(byId("wRows").value, 1, 32, 1);' +
        '  var cols = clampInt(byId("wCols").value, 1, 32, 3);' +
        '  var sid = clampInt(byId("wScreenId").value, 1, 999, 1);' +
        '  var mode = byId("wMode").value;' +
        '  var syncVal = byId("wSync").value;' +
        '  byId("wMasterWrap").style.display = (syncVal === "slave") ? "block" : "none";' +
        '  var pbtns = byId("wPresets").querySelectorAll("button");' +
        '  for (var p = 0; p < pbtns.length; p++) {' +
        '    var pr = parseInt(pbtns[p].getAttribute("data-r"), 10);' +
        '    var pc = parseInt(pbtns[p].getAttribute("data-c"), 10);' +
        '    pbtns[p].className = (pr === rows && pc === cols) ? "pbtn on" : "pbtn";' +
        '  }' +
        '  var total = rows * cols;' +
        '  var warn = byId("wWarn");' +
        '  if (mode === "tile" && sid > total) {' +
        '    byId("wWarnTxt").textContent = "ID #" + sid + " supera los " + total + " espacios de " + rows + "x" + cols + " (usará posición modular #" + (((sid - 1) % total) + 1) + " si no ampliás la matriz).";' +
        '    warn.style.display = "flex";' +
        '  } else {' +
        '    warn.style.display = "none";' +
        '  }' +
        '  var showR = Math.min(rows, 6);' +
        '  var showC = Math.min(cols, 8);' +
        '  var grid = byId("wMatrix");' +
        '  grid.style.gridTemplateColumns = "repeat(" + showC + ", minmax(54px, 1fr))";' +
        '  grid.innerHTML = "";' +
        '  for (var r = 0; r < showR; r++) {' +
        '    for (var c = 0; c < showC; c++) {' +
        '      var cid = (r * cols) + c + 1;' +
        '      var cell = document.createElement("div");' +
        '      cell.className = "mcell" + (cid === sid ? " active" : "");' +
        '      cell.setAttribute("data-id", String(cid));' +
        '      var lbl = document.createElement("span");' +
        '      lbl.textContent = "#" + cid;' +
        '      var sub = document.createElement("small");' +
        '      sub.textContent = "f" + (r + 1) + ",c" + (c + 1);' +
        '      cell.appendChild(lbl);' +
        '      cell.appendChild(sub);' +
        '      cell.onclick = function(){' +
        '        byId("wScreenId").value = this.getAttribute("data-id");' +
        '        updateWallPreview();' +
        '      };' +
        '      grid.appendChild(cell);' +
        '    }' +
        '  }' +
        '  var effIdx = (sid - 1) % total;' +
        '  var effR = Math.floor(effIdx / cols) + 1;' +
        '  var effC = (effIdx % cols) + 1;' +
        '  byId("wMatrixLabel").textContent = "Matriz " + rows + "x" + cols + " (" + total + " espacios) | ID actual #" + sid + " -> fila " + effR + ", col " + effC + (rows > showR || cols > showC ? " (vista parcial 6x8)" : "");' +
        '}' +
        'function openWallView(){' +
        '  showMsg("");' +
        '  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }' +
        '  if (lastStatus && lastStatus.wallConfig) {' +
        '    syncToForm(lastStatus.wallConfig, lastStatus.serverVideoWallFlag);' +
        '    wallLoaded = true;' +
        '  }' +
        '  byId("viewMonitor").className = "hide";' +
        '  byId("viewWall").className = "";' +
        '}' +
        'function closeWallView(){' +
        '  showMsg("");' +
        '  byId("viewWall").className = "hide";' +
        '  byId("viewMonitor").className = "";' +
        '  if (liveActive) scheduleLiveNext();' +
        '}' +
        'function refresh(){' +
        '  fetch("/api/status").then(function(r){ return r.json(); }).then(function(s){' +
        '    lastStatus = s;' +
        '    byId("ver").textContent = "v" + s.version;' +
        '    byId("meta").textContent = (s.model || "Linux") + " • IP " + (s.ip || "-") + (s.tailscaleIp ? (" • Tailscale " + s.tailscaleIp) : "") + " • " + s.displayBackend;' +
        '    byId("conn").textContent = s.connection ? "tbee.tv ONLINE" : "MODO OFFLINE";' +
        '    var pl = s.player || {};' +
        '    var playingLabel = (pl.file || s.filesPlaying.join(", ") || "En espera");' +
        '    byId("now").textContent = playingLabel;' +
        '    if (pl.duration && pl.duration > 0) {' +
        '      var pct = Math.max(0, Math.min(100, Math.round((pl.timePos / pl.duration) * 100)));' +
        '      byId("pbar").style.width = pct + "%";' +
        '      byId("ptime").textContent = fmtSec(pl.timePos) + " / " + fmtSec(pl.duration) + " (" + pct + "%) • " + (pl.bin || "mpv");' +
        '    } else {' +
        '      byId("pbar").style.width = "0%";' +
        '      byId("ptime").textContent = pl.active ? ("Motor: " + (pl.bin || "-")) : "Sin reproducción activa";' +
        '    }' +
        '    byId("hw").textContent = s.cpuUsage + "% / " + s.memPercentUsed + "% / " + s.temperature + "°C";' +
        '    byId("disk").textContent = s.freeSpace;' +
        '    byId("vw").textContent = s.wallActive ? (s.wallConfig.mode + " " + s.wallConfig.rows + "x" + s.wallConfig.cols + " #" + s.wallConfig.screenId + " (drift " + (s.wallSyncStatus.driftMs || 0) + "ms)") : ("Normal (" + (s.wallConfig.activationMode === "server" ? "remoto tbee.tv OFF" : "desactivado") + ")");' +
        '    byId("queues").textContent = "Bloque activo: " + s.blockPlaying + " | Bloques hoy: " + s.scheduleCount + " | Descargas FTP: " + s.queues.ftp + " | Imágenes: " + s.queues.render + " | Videos Opt: " + s.queues.videoOpt + " | Seamless activo: " + (s.queues.concatenating ? "Sí" : "No");' +
        '    byId("logs").textContent = (s.logs || []).join(nl) || "Sin logs";' +
        '    if (!wallLoaded && s.wallConfig) { syncToForm(s.wallConfig, s.serverVideoWallFlag); wallLoaded = true; }' +
        '  }).catch(function(){});' +
        '}' +
        'function act(u){' +
        '  fetch(u).then(function(r){ return r.text(); }).then(function(t){' +
        '    showMsg(t, "ok");' +
        '    refresh();' +
        '  }).catch(function(e){ showMsg("Error: " + e.message, "err"); });' +
        '}' +
        'function saveWall(){' +
        '  var actVal = byId("wAct").value;' +
        '  var syncVal = byId("wSync").value;' +
        '  var masterIp = byId("wMasterIp").value.trim();' +
        '  if (syncVal === "slave" && !masterIp) {' +
        '    showMsg("Ingresá la IP local del equipo Master.", "err");' +
        '    return;' +
        '  }' +
        '  var payload = {' +
        '    activationMode: (actVal === "server") ? "server" : "local",' +
        '    enabled: (actVal !== "local_off"),' +
        '    mode: byId("wMode").value,' +
        '    rows: clampInt(byId("wRows").value, 1, 32, 1),' +
        '    cols: clampInt(byId("wCols").value, 1, 32, 3),' +
        '    screenId: clampInt(byId("wScreenId").value, 1, 999, 1),' +
        '    bezelPx: clampInt(byId("wBezel").value, 0, 400, 0),' +
        '    orientation: clampInt(byId("wOrient").value, 0, 3, 0),' +
        '    syncMode: (syncVal === "ntp") ? "ntp" : "master",' +
        '    masterIp: (syncVal === "slave") ? masterIp : "",' +
        '    drmMode: Boolean(byId("wDrm").checked)' +
        '  };' +
        '  fetch("/api/wall", {' +
        '    method: "POST",' +
        '    headers: { "Content-Type": "application/json" },' +
        '    body: JSON.stringify(payload)' +
        '  }).then(function(r){ return r.json(); }).then(function(res){' +
        '    if (!res || !res.ok) { showMsg((res && res.error) ? res.error : "Error al guardar Video Wall", "err"); return; }' +
        '    wallLoaded = false;' +
        '    closeWallView();' +
        '    var info = "Video Wall guardado (" + res.config.mode + " " + res.config.rows + "x" + res.config.cols + " #" + res.config.screenId + ").";' +
        '    if (res.rotChanged) info += res.rotUpdated ? " HDMI rotate actualizado en config.txt (reiniciá la Pi para rotación física completa)." : " Aviso: rotación HDMI requiere sudo desde SSH (urp-wall).";' +
        '    showMsg(info, "ok");' +
        '    refresh();' +
        '  }).catch(function(e){ showMsg("Error guardando Video Wall: " + e.message, "err"); });' +
        '}' +
        'byId("btnOpenWall").onclick = openWallView;' +
        'byId("btnBackWall").onclick = closeWallView;' +
        'byId("btnCancelWall").onclick = function(){ wallLoaded = false; if (lastStatus && lastStatus.wallConfig) syncToForm(lastStatus.wallConfig, lastStatus.serverVideoWallFlag); closeWallView(); };' +
        'byId("btnResetWall").onclick = function(){ if (lastStatus && lastStatus.wallConfig) syncToForm(lastStatus.wallConfig, lastStatus.serverVideoWallFlag); showMsg("Valores restaurados al estado guardado.", ""); };' +
        'byId("btnSaveWall").onclick = saveWall;' +
        'byId("btnIdMinus").onclick = function(){ byId("wScreenId").value = Math.max(1, clampInt(byId("wScreenId").value, 1, 999, 1) - 1); updateWallPreview(); };' +
        'byId("btnIdPlus").onclick = function(){ byId("wScreenId").value = Math.min(999, clampInt(byId("wScreenId").value, 1, 999, 1) + 1); updateWallPreview(); };' +
        'byId("btnAutoExpand").onclick = function(){' +
        '  var sid = clampInt(byId("wScreenId").value, 1, 999, 1);' +
        '  byId("wRows").value = 1;' +
        '  byId("wCols").value = Math.min(32, sid);' +
        '  updateWallPreview();' +
        '};' +
        'var pbtns = byId("wPresets").querySelectorAll("button");' +
        'for (var bi = 0; bi < pbtns.length; bi++) {' +
        '  pbtns[bi].onclick = function(){' +
        '    byId("wRows").value = this.getAttribute("data-r");' +
        '    byId("wCols").value = this.getAttribute("data-c");' +
        '    updateWallPreview();' +
        '  };' +
        '}' +
        'var liveIds = ["wAct", "wMode", "wRows", "wCols", "wScreenId", "wBezel", "wOrient", "wSync"];' +
        'for (var li = 0; li < liveIds.length; li++) {' +
        '  byId(liveIds[li]).onchange = updateWallPreview;' +
        '  byId(liveIds[li]).oninput = updateWallPreview;' +
        '}' +
        'byId("btnToggleLive").onclick = function(){ setLiveMode(!liveActive); };' +
        'byId("liveInt").onchange = function(){ if (liveActive) scheduleLiveNext(); };' +
        'byId("btnRestartPlayer").onclick = function(){ act("/restartPlayer"); };' +
        'byId("btnUpdate").onclick = function(){ act("/update"); };' +
        'byId("btnGc").onclick = function(){ act("/gc"); };' +
        'byId("btnCleanLogs").onclick = function(){ act("/cleanLogs"); };' +
        'byId("btnShot").onclick = function(){ fetchLiveFrame(); };' +
        'byId("btnReboot").onclick = function(){ if (confirm("¿Reiniciar Raspberry Pi?")) act("/reboot"); };' +
        'byId("btnShutdown").onclick = function(){ if (confirm("¿Apagar Raspberry Pi?")) act("/shutdown"); };' +
        'byId("btnDelete").onclick = function(){ if (confirm("¿Borrar todo el contenido local?")) act("/deleteContents"); };' +
        'refresh();' +
        'setInterval(refresh, 3000);' +
        '</script></body></html>';
}

var express = require('express');
var app = express();
app.use(express.static(__dirname + '/web'));

app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.get('/', function (req, res) {
    res.status(200).type('html').send(buildLocalDashboardHtml());
});

app.get('/api/status', function (req, res) {
    loadWallConfig();
    var buildPayload = function (pl) {
        res.json({
            version: URPVersion,
            model: piModelStr,
            totalRamMB: totalRamMB,
            displayBackend: useDrmDirect ? 'DRM/KMS' : (hasWaylandDisplay ? 'Wayland' : 'X11'),
            ip: URPdata.URPIpAddress || '',
            tailscaleIp: getTailscaleIp(),
            mac: macAdd,
            uptimeSec: Math.round(process.uptime()),
            connection: iConn,
            freeSpace: URPFreeSpace,
            freeDiskMb: freeDiskMb,
            temperature: temperature,
            cpuUsage: cpuUsage,
            memPercentUsed: memPercentUsed,
            blockPlaying: blockPlaying,
            nowPlayingId: URPNowPlaying,
            filesPlaying: filesPlaying,
            player: pl,
            scheduleCount: Array.isArray(schedule) ? schedule.length : 0,
            serverVideoWallFlag: Boolean(URPdata && URPdata.isVideoWall),
            wallActive: isWallActive(),
            wallConfig: wallConfig,
            wallSyncStatus: wallSyncStatus,
            queues: {
                ftp: FTPcontents.length,
                render: renderQueue.length + (isRendering ? 1 : 0),
                videoOpt: videoOptQueue.length + (isOptimizingVideo ? 1 : 0),
                concatenating: isConcatenating
            },
            logs: recentLogs
        });
    };

    if (isPlaying && activePlayerProcess && activePlayerBin === 'mpv' && fs.existsSync(mpvIpcSocketPath)) {
        mpvIpcRequest([
            ['get_property', 'time-pos'],
            ['get_property', 'duration'],
            ['get_property', 'filename'],
            ['get_property', 'pause']
        ], function (err, ipcRes) {
            var pos = (!err && ipcRes && ipcRes[1] && ipcRes[1].error === 'success') ? (parseFloat(ipcRes[1].data) || 0) : 0;
            var dur = (!err && ipcRes && ipcRes[2] && ipcRes[2].error === 'success') ? (parseFloat(ipcRes[2].data) || 0) : 0;
            var fname = (!err && ipcRes && ipcRes[3] && ipcRes[3].error === 'success') ? String(ipcRes[3].data || '') : '';
            var paused = (!err && ipcRes && ipcRes[4] && ipcRes[4].error === 'success') ? Boolean(ipcRes[4].data) : false;
            buildPayload({
                active: Boolean(isPlaying),
                bin: activePlayerBin,
                file: fname || (filesPlaying[0] || ''),
                timePos: pos,
                duration: dur,
                paused: paused
            });
        });
    } else {
        buildPayload({
            active: Boolean(isPlaying),
            bin: activePlayerBin || (activeFehProcess ? 'imagen' : 'idle'),
            file: filesPlaying[0] || '',
            timePos: 0,
            duration: 0,
            paused: false
        });
    }
});

app.get('/api/preview.jpg', function (req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    captureLivePreview(function (ok, previewPath) {
        if (ok && fs.existsSync(previewPath)) {
            return res.sendFile(previewPath);
        }
        res.status(404).send('Sin captura disponible');
    });
});

app.get('/restartPlayer', function (req, res) {
    blockPlaying = 0;
    stopOmx(function () {
        setTimeout(function () { checkSchedule(); }, 250);
    });
    res.status(200).send('Reproductor reiniciado');
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
app.get('/gc', function (req, res) {
    garbageCollectUnusedMedia(false, function (info) {
        res.json(info);
    });
});
app.get('/cleanLogs', function (req, res) {
    cleanLogs();
    res.status(200).send('Clean Logs');
});
app.get('/uploadLogs', function (req, res) {
    uploadLogs(function (ok) {
        res.status(200).send(ok ? 'Logs uploaded' : 'No logs');
    });
});
app.get('/screenshot', function (req, res) {
    takeScreenshot(function (ok) {
        res.status(ok ? 200 : 500).send(ok ? 'Screenshot OK' : 'Screenshot failed');
    });
});
app.get('/screenshot.jpg', function (req, res) {
    var p = basePath + 'screenshot.jpg';
    if (fs.existsSync(p)) return res.sendFile(p);
    res.status(404).send('No screenshot');
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
app.get('/URPTemperature', function (req, res) { res.json({ temperature: temperature }); });
app.get('/URPmemPercentUsed', function (req, res) { res.json({ memPercentUsed: memPercentUsed }); });
app.get('/URPcpuUsage', function (req, res) { res.json({ cpuUsage: cpuUsage }); });
app.get('/update', function (req, res) {
    checkGithubOTA(function (result) { res.json(result); });
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
app.post('/api/wall', function (req, res) {
    readJsonBody(req, function (err, body) {
        if (err || !body || typeof body !== 'object') {
            return res.status(400).json({ ok: false, error: 'JSON inválido' });
        }
        try {
            loadWallConfig();
            var prevRot = wallConfig.orientation;
            var rows = Math.max(1, Math.min(32, parseInt(body.rows, 10) || 1));
            var cols = Math.max(1, Math.min(32, parseInt(body.cols, 10) || 1));
            var total = rows * cols;
            var screenId = Math.max(1, Math.min(999, parseInt(body.screenId, 10) || 1));
            var effIdx = (screenId - 1) % total;
            var orientation = [0, 1, 2, 3].indexOf(parseInt(body.orientation, 10)) !== -1 ? parseInt(body.orientation, 10) : 0;
            var actMode = (body.activationMode === 'server' || body.activationMode === 'local') ? body.activationMode : 'local';
            var nextCfg = {
                enabled: (actMode === 'server') ? true : Boolean(body.enabled),
                activationMode: actMode,
                mode: (body.mode === 'mirror') ? 'mirror' : 'tile',
                screenId: screenId,
                rows: rows,
                cols: cols,
                row: Math.floor(effIdx / cols),
                col: effIdx % cols,
                bezelPx: Math.max(0, Math.min(400, parseInt(body.bezelPx, 10) || 0)),
                orientation: orientation,
                syncMode: (body.syncMode === 'master') ? 'master' : 'ntp',
                masterIp: String(body.masterIp || '').trim(),
                drmMode: Boolean(body.drmMode),
                updatedAt: new Date().toISOString()
            };

            ensureDir(basePath);
            var tmpPath = wallConfigPath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(nextCfg, null, 2) + '\n', 'utf8');
            fs.renameSync(tmpPath, wallConfigPath);
            wallConfigMtime = 0;
            loadWallConfig();

            var rotChanged = (orientation !== prevRot);
            var rotUpdated = false;
            if (rotChanged) {
                var rotRes = writeHdmiRotateToConfig(orientation);
                rotUpdated = Boolean(rotRes && rotRes.ok);
            }

            clearWallDerivedCaches();
            blockPlaying = 0;
            stopOmx(function () {
                setTimeout(function () { checkSchedule(); }, 250);
            });

            res.json({
                ok: true,
                config: wallConfig,
                wallActive: isWallActive(),
                rotChanged: rotChanged,
                rotUpdated: rotUpdated
            });
        } catch (saveErr) {
            res.status(500).json({ ok: false, error: saveErr.message });
        }
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
        console.warn("[SERVER] Puerto " + URPPort + " ya ocupado por otra instancia previa.");
    } else {
        console.error("[SERVER ERROR]", err.message);
    }
});
try {
    server.listen(URPPort, function () {
        console.log("URPPI3 Server v" + URPVersion + " escuchando en puerto " + URPPort);
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
