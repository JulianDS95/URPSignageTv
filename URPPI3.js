var URPActive = true;
var URPType = 'URPPI3';
var URPVersion = '2.5.5';
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
var throttleStatus = { raw: '0x0', ok: true, underVoltageNow: false, underVoltagePast: false, throttledNow: false, label: 'OK' };
var isScreenPoweredOff = false;
var manualScreenOffOverride = null;
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
var MAX_RECENT_LOGS = 200;
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
        if (getTargetVideoDims().convertEnabled) {
            setTimeout(prebuildAllScheduleBlocks, 2500);
        }
    }
}, 5000);

var mpvCaps = {
    probed: false,
    glChecked: false,
    hwdecs: [],
    vos: [],
    gpuContexts: [],
    options: {},
    glRenderer: '',
    isSoftwareGl: false
};
var mpvSafeFallback = false;
var activeMpvDriverInfo = '';

function mpvHasOption(name) {
    return Boolean(mpvCaps && mpvCaps.options && mpvCaps.options[name]);
}
function mpvHasVo(name) {
    return Boolean(mpvCaps && Array.isArray(mpvCaps.vos) && mpvCaps.vos.indexOf(name) !== -1);
}
function mpvHasGpuCtx(name) {
    return Boolean(mpvCaps && Array.isArray(mpvCaps.gpuContexts) && mpvCaps.gpuContexts.indexOf(name) !== -1);
}
function mpvFilterHwdecs(candidates) {
    if (!mpvCaps || !Array.isArray(mpvCaps.hwdecs) || mpvCaps.hwdecs.length === 0) return [];
    var out = [];
    for (var i = 0; i < candidates.length; i++) {
        if (mpvCaps.hwdecs.indexOf(candidates[i]) !== -1 && out.indexOf(candidates[i]) === -1) {
            out.push(candidates[i]);
        }
    }
    return out;
}

function detectMpvCapabilities() {
    if (!isArm && !isLinux) return;
    if (!hasMpv) return;
    if (!mpvCaps.probed) {
        mpvCaps.probed = true;
        try {
            var hwOut = execSync('mpv --hwdec=help 2>/dev/null || true', { timeout: 2500, encoding: 'utf8' });
            var hwLines = String(hwOut || '').split(/\r?\n/);
            for (var hi = 0; hi < hwLines.length; hi++) {
                var hm = /^\s+([a-z0-9_-]+)/i.exec(hwLines[hi]);
                if (hm && hm[1] && hm[1] !== 'no' && mpvCaps.hwdecs.indexOf(hm[1]) === -1) {
                    mpvCaps.hwdecs.push(hm[1]);
                }
            }
        } catch (e) {}
        try {
            var voOut = execSync('mpv --vo=help 2>/dev/null || true', { timeout: 2500, encoding: 'utf8' });
            var voLines = String(voOut || '').split(/\r?\n/);
            for (var vi = 0; vi < voLines.length; vi++) {
                var vm = /^\s+([a-z0-9_-]+)/i.exec(voLines[vi]);
                if (vm && vm[1] && mpvCaps.vos.indexOf(vm[1]) === -1) {
                    mpvCaps.vos.push(vm[1]);
                }
            }
        } catch (e) {}
        try {
            var gcOut = execSync('mpv --gpu-context=help 2>/dev/null || true', { timeout: 2500, encoding: 'utf8' });
            var gcLines = String(gcOut || '').split(/\r?\n/);
            for (var gi = 0; gi < gcLines.length; gi++) {
                var gm = /^\s+([a-z0-9_-]+)/i.exec(gcLines[gi]);
                if (gm && gm[1] && gm[1] !== 'auto' && mpvCaps.gpuContexts.indexOf(gm[1]) === -1) {
                    mpvCaps.gpuContexts.push(gm[1]);
                }
            }
        } catch (e) {}
        try {
            var optOut = execSync('mpv --list-options 2>/dev/null || true', { timeout: 3000, encoding: 'utf8' });
            var optLines = String(optOut || '').split(/\r?\n/);
            for (var oi = 0; oi < optLines.length; oi++) {
                var om = /^\s+--([a-z0-9-]+)/i.exec(optLines[oi]);
                if (om && om[1]) mpvCaps.options[om[1]] = true;
            }
        } catch (e) {}
    }
    if (hasX11Display && !mpvCaps.glChecked) {
        mpvCaps.glChecked = true;
        try {
            var glEnv = Object.assign({}, process.env, { DISPLAY: process.env.DISPLAY || ':0', XAUTHORITY: getXauthPath() });
            var glOut = execSync('glxinfo -B 2>/dev/null || true', { env: glEnv, timeout: 2500, encoding: 'utf8' });
            var rm = /OpenGL renderer string:\s*(.+)/i.exec(String(glOut || ''));
            if (!rm) {
                var es2Out = execSync('es2_info 2>/dev/null || true', { env: glEnv, timeout: 2500, encoding: 'utf8' });
                rm = /GL_RENDERER\s*[:=]\s*(.+)/i.exec(String(es2Out || ''));
            }
            if (rm && rm[1]) {
                mpvCaps.glRenderer = rm[1].trim();
                mpvCaps.isSoftwareGl = /llvmpipe|softpipe|swrast/i.test(mpvCaps.glRenderer);
            } else {
                var hasRenderNode = false;
                try {
                    if (fs.existsSync('/dev/dri')) {
                        var driList = fs.readdirSync('/dev/dri');
                        for (var di = 0; di < driList.length; di++) {
                            if (/^renderD\d+/.test(driList[di])) { hasRenderNode = true; break; }
                        }
                    }
                } catch (de) {}
                var hasVcKmod = false;
                try {
                    var lsmodOut = execSync('lsmod 2>/dev/null || true', { timeout: 1500, encoding: 'utf8' });
                    hasVcKmod = /^(vc4|v3d)\b/m.test(String(lsmodOut || ''));
                } catch (ke) {}
                var xorgFbdev = false;
                var xLogs = ['/var/log/Xorg.0.log', (process.env.HOME || '/home/pi') + '/.local/share/xorg/Xorg.0.log'];
                for (var xi = 0; xi < xLogs.length; xi++) {
                    try {
                        if (fs.existsSync(xLogs[xi])) {
                            var xtxt = fs.readFileSync(xLogs[xi], 'utf8');
                            if (/FBDEV\(0\)|glamor initialization failed|Failed to initialize glamor|not DRI2 capable|llvmpipe|swrast/i.test(xtxt)) {
                                xorgFbdev = true;
                                break;
                            }
                        }
                    } catch (xe) {}
                }
                if (!hasRenderNode || !hasVcKmod || xorgFbdev || isLowPowerPi) {
                    mpvCaps.isSoftwareGl = true;
                    mpvCaps.glRenderer = xorgFbdev ? 'Xorg-FBDEV (sin glamor)' : (!hasRenderNode ? 'Sin nodo /dev/dri/renderD*' : 'X11 Ligero (OpenGL no confirmado)');
                }
            }
            if (mpvCaps.isSoftwareGl) {
                console.warn('[DISPLAY:GPU] Modo X11 ligero activo (' + mpvCaps.glRenderer + '). Se evita OpenGL por software para mantener CPU baja.');
            } else if (mpvCaps.glRenderer) {
                console.log('[DISPLAY:GPU] Aceleración OpenGL detectada: ' + mpvCaps.glRenderer);
            }
        } catch (e) {}
    }
}

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
    detectMpvCapabilities();
    var outMode = (wallConfig && wallConfig.videoOutputMode) ? wallConfig.videoOutputMode : 'auto';
    var forceDrm = (process.env.URP_DRM_MODE === '1') || Boolean(wallConfig && (wallConfig.drmMode || outMode === 'drm'));
    useDrmDirect = hasMpv && ((forceDrm && !hasX11Display && !hasWaylandDisplay) || (!hasX11Display && !hasWaylandDisplay));
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
    drmMode: false,
    resolutionMode: 'auto',
    hdmi720p: true,
    orientationOverride: false,
    videoOutputMode: 'auto',
    audioVolume: 100,
    audioMuted: false,
    audioOutput: 'auto',
    screenScheduleEnabled: false,
    screenOnTime: '08:00',
    screenOffTime: '22:00',
    showStandbyScreen: true,
    remoteConfigVersion: 0,
    panelPinHash: ''
};
var wallConfigMtime = 0;
var lastWallSignatureLogged = '';

function sanitizeTimeHHMM(val, fallback) {
    var s = String(val || '').trim();
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(s) ? s : fallback;
}

function getWallConfigPublic() {
    var copy = Object.assign({}, wallConfig);
    delete copy.panelPinHash;
    return copy;
}

function loadWallConfig() {
    try {
        if (!fs.existsSync(wallConfigPath)) {
            wallConfig = {
                enabled: false, activationMode: 'server', mode: 'mirror', screenId: 1,
                rows: 1, cols: 1, row: 0, col: 0, bezelPx: 0,
                orientation: 0, syncMode: 'ntp', masterIp: '', drmMode: false,
                resolutionMode: 'auto', hdmi720p: true, orientationOverride: false,
                videoOutputMode: 'auto',
                audioVolume: 100, audioMuted: false, audioOutput: 'auto',
                screenScheduleEnabled: false, screenOnTime: '08:00', screenOffTime: '22:00',
                showStandbyScreen: true, remoteConfigVersion: 0, panelPinHash: ''
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
        var resMode = (parsed.resolutionMode === '720p' || parsed.resolutionMode === '1080p' || parsed.resolutionMode === 'direct')
            ? parsed.resolutionMode
            : 'auto';

        var voMode = (parsed.videoOutputMode === 'x11_light' || parsed.videoOutputMode === 'gpu_egl' || parsed.videoOutputMode === 'drm')
            ? parsed.videoOutputMode
            : (parsed.drmMode ? 'drm' : 'auto');
        var audVol = (typeof parsed.audioVolume === 'number' && !isNaN(parsed.audioVolume))
            ? Math.max(0, Math.min(100, Math.round(parsed.audioVolume)))
            : 100;
        var audOut = (parsed.audioOutput === 'hdmi' || parsed.audioOutput === 'jack') ? parsed.audioOutput : 'auto';

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
            drmMode: Boolean(parsed.drmMode || voMode === 'drm'),
            resolutionMode: resMode,
            hdmi720p: (parsed.hdmi720p === undefined) ? true : Boolean(parsed.hdmi720p),
            orientationOverride: Boolean(parsed.orientationOverride),
            videoOutputMode: voMode,
            audioVolume: audVol,
            audioMuted: Boolean(parsed.audioMuted),
            audioOutput: audOut,
            screenScheduleEnabled: Boolean(parsed.screenScheduleEnabled),
            screenOnTime: sanitizeTimeHHMM(parsed.screenOnTime, '08:00'),
            screenOffTime: sanitizeTimeHHMM(parsed.screenOffTime, '22:00'),
            showStandbyScreen: (parsed.showStandbyScreen === undefined) ? true : Boolean(parsed.showStandbyScreen),
            remoteConfigVersion: Math.max(0, parseInt(parsed.remoteConfigVersion, 10) || 0),
            panelPinHash: (typeof parsed.panelPinHash === 'string' && parsed.panelPinHash.indexOf(':') > 0) ? parsed.panelPinHash : ''
        };
        wallConfigMtime = st.mtime.getTime();
        detectDisplaySession();

        var sig = wallConfig.activationMode + '_' + wallConfig.enabled + '_' + wallConfig.mode + '_' + wallConfig.rows + 'x' + wallConfig.cols + '_id' + wallConfig.screenId + '_' + wallConfig.syncMode + '_drm' + useDrmDirect + '_res' + wallConfig.resolutionMode;
        if (sig !== lastWallSignatureLogged) {
            lastWallSignatureLogged = sig;
            var dimsLog = getTargetVideoDims();
            var modeDesc = (dimsLog.mode === 'direct' && !isWallTileActive()) ? ('Directo sin ffmpeg (HDMI ' + (dimsLog.use720p ? '720p' : 'nativo') + ')') : ((dimsLog.mode === 'auto' ? 'Inteligente ' : 'Forzado ') + dimsLog.width + 'x' + dimsLog.height);
            console.log('[DISPLAY:SESION] Salida=' + (useDrmDirect ? 'DRM/KMS directo (sin X11)' : (hasWaylandDisplay ? 'Wayland' : 'X11')) + ' | Modo=' + modeDesc);
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
    var envRes = String(process.env.URP_RESOLUTION || '').trim().toLowerCase();
    var cfgRes = (wallConfig && wallConfig.resolutionMode) ? String(wallConfig.resolutionMode).toLowerCase() : 'auto';
    var effectiveMode = (envRes === 'auto' || envRes === 'direct' || envRes === '720p' || envRes === '1080p') ? envRes : cfgRes;
    if (effectiveMode !== '720p' && effectiveMode !== '1080p' && effectiveMode !== 'direct') effectiveMode = 'auto';
    var wallTileOn = (typeof isWallTileActive === 'function') ? isWallTileActive() : false;
    var convertEnabled = (effectiveMode !== 'direct') || wallTileOn;
    var use720p = (effectiveMode === '720p') ? true : ((effectiveMode === '1080p') ? false : isLowPowerPi);
    var longEdge = use720p ? 1280 : 1920;
    var shortEdge = use720p ? 720 : 1080;
    return {
        width: isVert ? shortEdge : longEdge,
        height: isVert ? longEdge : shortEdge,
        use720p: use720p,
        convertEnabled: convertEnabled,
        mode: effectiveMode,
        fps: use720p ? 24 : 25,
        preset: (use720p || isLowPowerPi) ? 'ultrafast' : 'veryfast',
        profile: use720p ? 'baseline' : 'main',
        level: use720p ? '3.1' : '4.0',
        crf: use720p ? '25' : '22',
        maxRate: use720p ? '2200k' : '4200k',
        bufSize: use720p ? '4400k' : '8400k',
        threads: isLowPowerPi ? '1' : '2'
    };
}

function getEncodingBackpressureReason() {
    if (!isArm && !isLinux) return '';
    try {
        var totMem = osMod.totalmem();
        var frMem = osMod.freemem();
        var curMemPct = (totMem > 0) ? Math.round(((totMem - frMem) * 100) / totMem) : 0;
        if (isLowPowerPi && curMemPct >= 75) {
            return 'RAM alta (' + curMemPct + '%)';
        }
        if (temperature >= 72) {
            return 'Temperatura alta (' + temperature + '°C)';
        }
        if (isLowPowerPi && cpuUsage >= 70) {
            return 'CPU ocupada (' + cpuUsage + '%)';
        }
    } catch (e) {}
    return '';
}

function spawnFfmpegLowPriority(ffArgs) {
    if (isLinux && hasNice) {
        return spawn('nice', ['-n', '19', 'ffmpeg'].concat(ffArgs), { stdio: ['ignore', 'ignore', 'pipe'] });
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

// ==============================================================================
// 1A. SEGURIDAD PIN (:8090), AUDIO/VOLUMEN, AHORRO HDMI Y STANDBY OFFLINE
// ==============================================================================
var authSessions = {};
var authFailures = {};
var AUTH_SESSION_TTL_MS = 24 * 3600 * 1000;

function getPanelAuthConfig() {
    var envPin = String(process.env.URP_PANEL_PIN || '').trim();
    if (envPin.length > 0) {
        return { enabled: true, envManaged: true };
    }
    var storedHash = (wallConfig && wallConfig.panelPinHash) ? String(wallConfig.panelPinHash) : '';
    return { enabled: storedHash.indexOf(':') > 0, envManaged: false };
}

function hashPinScrypt(pinStr) {
    var salt = crypto.randomBytes(16).toString('hex');
    var derived = crypto.scryptSync(String(pinStr), salt, 32).toString('hex');
    return salt + ':' + derived;
}

function verifyPinScrypt(pinStr, storedHash) {
    try {
        var parts = String(storedHash || '').split(':');
        if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
        var expectedBuf = Buffer.from(parts[1], 'hex');
        var actualBuf = crypto.scryptSync(String(pinStr), parts[0], 32);
        if (expectedBuf.length !== actualBuf.length) return false;
        return crypto.timingSafeEqual(expectedBuf, actualBuf);
    } catch (e) {
        return false;
    }
}

function verifyPanelPin(candidatePin) {
    var cand = String(candidatePin || '');
    if (!cand) return false;
    var envPin = String(process.env.URP_PANEL_PIN || '').trim();
    if (envPin.length > 0) {
        var hA = crypto.createHash('sha256').update(cand).digest();
        var hB = crypto.createHash('sha256').update(envPin).digest();
        return crypto.timingSafeEqual(hA, hB);
    }
    return verifyPinScrypt(cand, wallConfig && wallConfig.panelPinHash);
}

function issueAuthToken() {
    var now = Date.now();
    var keys = Object.keys(authSessions);
    for (var i = 0; i < keys.length; i++) {
        if (authSessions[keys[i]] < now) delete authSessions[keys[i]];
    }
    var tok = crypto.randomBytes(32).toString('hex');
    authSessions[tok] = now + AUTH_SESSION_TTL_MS;
    return tok;
}

function isRequestAuthenticated(req) {
    if (!getPanelAuthConfig().enabled) return true;
    var authHdr = String((req.headers && req.headers.authorization) || '');
    if (authHdr.indexOf('Bearer ') !== 0) return false;
    var tok = authHdr.slice(7).trim();
    if (!tok || !authSessions[tok]) return false;
    if (authSessions[tok] < Date.now()) {
        delete authSessions[tok];
        return false;
    }
    return true;
}

function requirePanelAuth(req, res, next) {
    if (isRequestAuthenticated(req)) return next();
    res.status(401).json({ ok: false, authRequired: true, error: 'PIN requerido para acceder al panel' });
}

function saveWallConfigPartial(patchObj) {
    loadWallConfig();
    var nextCfg = Object.assign({}, wallConfig, patchObj, { updatedAt: new Date().toISOString() });
    ensureDir(basePath);
    var tmpPath = wallConfigPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(nextCfg, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, wallConfigPath);
    wallConfigMtime = 0;
    return loadWallConfig();
}

function applyAudioSettings(callback) {
    loadWallConfig();
    var vol = Math.max(0, Math.min(100, parseInt(wallConfig.audioVolume, 10)));
    if (isNaN(vol)) vol = 100;
    var muted = Boolean(wallConfig.audioMuted);
    var outMode = (wallConfig.audioOutput === 'hdmi' || wallConfig.audioOutput === 'jack') ? wallConfig.audioOutput : 'auto';

    if (isPlaying && activePlayerProcess && activePlayerBin === 'mpv' && fs.existsSync(mpvIpcSocketPath)) {
        mpvIpcRequest([
            ['set_property', 'mute', muted],
            ['set_property', 'volume', vol]
        ], function () {});
    }

    if (!isArm && !isLinux) {
        if (typeof callback === 'function') callback();
        return;
    }

    var routeNum = (outMode === 'hdmi') ? 2 : ((outMode === 'jack') ? 1 : 0);
    var muteFlag = muted ? 'mute' : 'unmute';
    var cmds = [
        'amixer sset Master ' + vol + '% ' + muteFlag + ' >/dev/null 2>&1 || amixer sset PCM ' + vol + '% ' + muteFlag + ' >/dev/null 2>&1 || true'
    ];
    if (outMode !== 'auto') {
        cmds.push('amixer cset numid=3 ' + routeNum + ' >/dev/null 2>&1 || true');
    }
    cmds.push('if command -v wpctl >/dev/null 2>&1; then wpctl set-volume @DEFAULT_AUDIO_SINK@ ' + (vol / 100).toFixed(2) + ' >/dev/null 2>&1 || true; wpctl set-mute @DEFAULT_AUDIO_SINK@ ' + (muted ? '1' : '0') + ' >/dev/null 2>&1 || true; fi');

    exec(cmds.join('; '), { env: getGuiEnv(), timeout: 3000 }, function () {
        if (typeof callback === 'function') callback();
    });
}

function isWithinScreenOffWindow() {
    if (manualScreenOffOverride !== null) {
        return Boolean(manualScreenOffOverride);
    }
    if (!wallConfig || !wallConfig.screenScheduleEnabled) return false;
    var onParts = sanitizeTimeHHMM(wallConfig.screenOnTime, '08:00').split(':');
    var offParts = sanitizeTimeHHMM(wallConfig.screenOffTime, '22:00').split(':');
    var onMin = (parseInt(onParts[0], 10) * 60) + parseInt(onParts[1], 10);
    var offMin = (parseInt(offParts[0], 10) * 60) + parseInt(offParts[1], 10);
    if (onMin === offMin) return false;
    var now = new Date();
    var curMin = (now.getHours() * 60) + now.getMinutes();
    if (onMin < offMin) {
        return (curMin < onMin || curMin >= offMin);
    }
    return (curMin >= offMin && curMin < onMin);
}

function applyScreenPowerState(turnOn, callback) {
    var shouldOff = !turnOn;
    var changed = (isScreenPoweredOff !== shouldOff);
    isScreenPoweredOff = shouldOff;

    if (!isArm && !isLinux) {
        if (typeof callback === 'function') callback(changed);
        return;
    }

    var env = getGuiEnv();
    var cmd = '';
    if (turnOn) {
        cmd = '(/usr/bin/vcgencmd display_power 1 || /opt/vc/bin/vcgencmd display_power 1 || true) >/dev/null 2>&1; ' +
              'if command -v xrandr >/dev/null 2>&1; then OUT=$(xrandr --query 2>/dev/null | awk "/ connected/{print \$1; exit}"); [ -n "$OUT" ] && xrandr --output "$OUT" --auto >/dev/null 2>&1 || true; fi; ' +
              'if command -v wlr-randr >/dev/null 2>&1; then WOUT=$(wlr-randr 2>/dev/null | awk "/^HDMI|^DP|^DSI/{print \$1; exit}"); [ -n "$WOUT" ] && wlr-randr --output "$WOUT" --on >/dev/null 2>&1 || true; fi; ' +
              'if command -v cec-client >/dev/null 2>&1; then echo "on 0" | cec-client -s -d 1 >/dev/null 2>&1 || true; fi';
    } else {
        cmd = '(/usr/bin/vcgencmd display_power 0 || /opt/vc/bin/vcgencmd display_power 0 || true) >/dev/null 2>&1; ' +
              'if command -v xrandr >/dev/null 2>&1; then OUT=$(xrandr --query 2>/dev/null | awk "/ connected/{print \$1; exit}"); [ -n "$OUT" ] && xrandr --output "$OUT" --off >/dev/null 2>&1 || true; fi; ' +
              'if command -v wlr-randr >/dev/null 2>&1; then WOUT=$(wlr-randr 2>/dev/null | awk "/^HDMI|^DP|^DSI/{print \$1; exit}"); [ -n "$WOUT" ] && wlr-randr --output "$WOUT" --off >/dev/null 2>&1 || true; fi; ' +
              'if command -v cec-client >/dev/null 2>&1; then echo "standby 0" | cec-client -s -d 1 >/dev/null 2>&1 || true; fi';
    }

    exec(cmd, { env: env, timeout: 6000 }, function () {
        if (changed) {
            console.log('[POWER] Pantalla HDMI ' + (turnOn ? 'ENCENDIDA' : 'APAGADA (ahorro de energía)') + '.');
        }
        if (shouldOff && isPlaying) {
            stopOmx(function () {
                if (typeof callback === 'function') callback(changed);
            });
            return;
        }
        if (turnOn && changed && !isPlaying) {
            setTimeout(function () { checkSchedule(); }, 400);
        }
        if (typeof callback === 'function') callback(changed);
    });
}

function syncScreenPowerSchedule() {
    var shouldOff = isWithinScreenOffWindow();
    if (shouldOff !== isScreenPoweredOff) {
        applyScreenPowerState(!shouldOff);
    }
    return shouldOff;
}

var standbyFallbackImagePath = basePath + 'standby_urp.png';
var standbyAssetGenerating = false;
function ensureStandbyScreenAsset() {
    if (!isArm && !isLinux) return;
    if (fs.existsSync(standbyFallbackImagePath) || standbyAssetGenerating) return;
    standbyAssetGenerating = true;
    var tmpPath = basePath + '.standby_urp.tmp.png';
    var ffArgs = [
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=#090d16:s=1280x720:d=1',
        '-vf', "drawbox=x=140:y=220:w=1000:h=280:color=#111827@0.95:t=fill,drawbox=x=140:y=220:w=1000:h=280:color=#2563eb@0.7:t=2,drawtext=text='URP Digital Signage v" + URPVersion + "':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=290,drawtext=text='Esperando programacion de tbee.tv (Panel web puerto 8090)':fontcolor=#94a3b8:fontsize=24:x=(w-text_w)/2:y=375",
        '-frames:v', '1', tmpPath
    ];
    var p = spawn('ffmpeg', ffArgs, { stdio: 'ignore' });
    p.on('close', function (code) {
        standbyAssetGenerating = false;
        if (code === 0 && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 512) {
            try { fs.renameSync(tmpPath, standbyFallbackImagePath); } catch (e) {}
        } else {
            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
            try { fs.writeFileSync(standbyFallbackImagePath, Buffer.from(BLACK_CURTAIN_PNG_B64, 'base64')); } catch (e2) {}
        }
    });
    p.on('error', function () { standbyAssetGenerating = false; });
}
setTimeout(ensureStandbyScreenAsset, 4000);

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
    if (wallConfig && wallConfig.orientationOverride && typeof wallConfig.orientation === 'number' && wallConfig.orientation >= 0 && wallConfig.orientation <= 3) {
        return wallConfig.orientation;
    }
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
    if (wallConfig && typeof wallConfig.orientation === 'number' && wallConfig.orientation >= 0 && wallConfig.orientation <= 3) {
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
    var xrandrDir = (cfgRot === 0) ? 'normal' : ((cfgRot === 1) ? 'right' : (cfgRot === 2 ? 'inverted' : 'left'));
    var wlrTrans = (cfgRot === 0) ? 'normal' : ((cfgRot === 1) ? '90' : (cfgRot === 2 ? '180' : '270'));

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
           "  if [ \"" + cfgRot + "\" = \"0\" ]; then " +
           "    if ! echo \"$CUR\" | grep -qE ' (right|left|inverted) [(]' && [ -n \"$W\" ] && [ -n \"$H\" ] && [ \"$W\" -ge \"$H\" ] 2>/dev/null; then ALREADY=1; fi; " +
           "  elif [ \"" + cfgRot + "\" = \"2\" ]; then " +
           "    echo \"$CUR\" | grep -qE ' inverted [(]' && ALREADY=1; " +
           "  else " +
           "    if [ -n \"$W\" ] && [ -n \"$H\" ] && [ \"$W\" -lt \"$H\" ] 2>/dev/null; then ALREADY=1; fi; " +
           "    echo \"$CUR\" | grep -qE ' (right|left) [(]' && ALREADY=1; " +
           "  fi; " +
           "  if [ \"$ALREADY\" = \"0\" ]; then " +
           "    if xrandr --output \"$OUT\" --rotate " + xrandrDir + " 2>/dev/null; then " +
           "      DID_CHANGE=1; OS_ROTATED=" + (cfgRot === 0 ? "0" : "1") + "; " +
           "    fi; " +
           "  else " +
           "    OS_ROTATED=" + (cfgRot === 0 ? "0" : "1") + "; " +
           "  fi; " +
           "fi; " +
           "if [ \"$OS_ROTATED\" = \"0\" ] && command -v wlr-randr >/dev/null 2>&1; then " +
           "  WOUT=$(wlr-randr 2>/dev/null | awk '/^HDMI|^DP|^DSI/{print $1; exit}'); " +
           "  if [ -n \"$WOUT\" ]; then " +
           "    BACKEND=wayland; " +
           "    CUR_T=$(wlr-randr 2>/dev/null | awk -v o=\"$WOUT\" '$0 ~ \"^\"o{f=1;next} f && /Transform:/{print $2;exit}'); " +
           "    if [ \"$CUR_T\" = \"" + wlrTrans + "\" ]; then " +
           "      OS_ROTATED=" + (cfgRot === 0 ? "0" : "1") + "; " +
           "    elif wlr-randr --output \"$WOUT\" --transform " + wlrTrans + " 2>/dev/null; then " +
           "      DID_CHANGE=1; OS_ROTATED=" + (cfgRot === 0 ? "0" : "1") + "; " +
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

var lastAppliedRot = null;
function applyDisplayRotationIfNeeded(callback, forceCheck) {
    if (!isArm && !isLinux || useDrmDirect) {
        osScreenRotated = false;
        if (callback) callback(false);
        return;
    }
    var cfgRot = readHdmiRotateFromConfig();
    if (cfgRot === null) {
        osScreenRotated = false;
        if (callback) callback(false);
        return;
    }
    if (cfgRot === 0 && !osScreenRotated) {
        lastAppliedRot = 0;
        osScreenRotated = false;
        if (callback) callback(false);
        return;
    }
    if (!forceCheck && lastAppliedRot === cfgRot && (osScreenRotated || cfgRot === 0)) {
        if (callback) callback(false);
        return;
    }
    exec(buildDisplayRotationScript(cfgRot), function (err, stdout) {
        var didChange = handleDisplayRotationResult(cfgRot, stdout);
        if (!err) lastAppliedRot = cfgRot;
        if (callback) callback(didChange);
    });
}
refreshDisplayRotationSync();

var lastAppliedHdmiRes = '';
function applyDisplayResolution720pIfNeeded(forceCheck) {
    if (!isArm && !isLinux) return;
    if (useDrmDirect || (!hasX11Display && !hasWaylandDisplay)) return;
    if (process.env.URP_HDMI_AUTO_720P === '0') return;
    if (wallConfig && wallConfig.hdmi720p === false) return;
    var dims = getTargetVideoDims();
    if (!dims.use720p) return;
    if (!forceCheck && lastAppliedHdmiRes === '1280x720') return;

    var wl = getWaylandEnv();
    var script = "export DISPLAY=:0; export XAUTHORITY=\"" + getXauthPath() + "\"; " +
                 "export XDG_RUNTIME_DIR=\"" + wl.runtimeDir + "\"; " +
                 (wl.waylandDisplay ? "export WAYLAND_DISPLAY=\"" + wl.waylandDisplay + "\"; " : "") +
                 "APPLIED=0; " +
                 "OUT=$(xrandr --query 2>/dev/null | awk '/ connected/ && $1 !~ /^XWAYLAND/{print $1; exit}'); " +
                 "if [ -n \"$OUT\" ]; then " +
                 "  XQ=$(xrandr --query 2>/dev/null); " +
                 "  CUR_LINE=$(echo \"$XQ\" | awk -v o=\"$OUT\" '$1==o{print; exit}'); " +
                 "  if echo \"$CUR_LINE\" | grep -qE '(1280x720|720x1280)'; then APPLIED=already; " +
                 "  elif echo \"$XQ\" | awk -v o=\"$OUT\" '$1==o{f=1;next} f && /^[^ ]/{exit} f{print}' | grep -q '1280x720'; then " +
                 "    if xrandr --output \"$OUT\" --mode 1280x720 2>/dev/null; then APPLIED=x11_720p; fi; " +
                 "  fi; " +
                 "fi; " +
                 "if [ \"$APPLIED\" = \"0\" ] && command -v wlr-randr >/dev/null 2>&1; then " +
                 "  WOUT=$(wlr-randr 2>/dev/null | awk '/^HDMI|^DP|^DSI/{print $1; exit}'); " +
                 "  if [ -n \"$WOUT\" ]; then " +
                 "    if wlr-randr 2>/dev/null | awk -v o=\"$WOUT\" '$0 ~ \"^\"o{f=1;next} f && /^[^ ]/{exit} f{print}' | grep -qE '1280x720.*current'; then APPLIED=already; " +
                 "    elif wlr-randr --output \"$WOUT\" --mode 1280x720 2>/dev/null; then APPLIED=wayland_720p; fi; " +
                 "  fi; " +
                 "fi; " +
                 "echo \"HDMI720=$APPLIED\"";

    exec(script, { timeout: 4000 }, function (err, stdout) {
        if (!err && stdout) {
            if (stdout.indexOf('HDMI720=x11_720p') !== -1 || stdout.indexOf('HDMI720=wayland_720p') !== -1) {
                lastAppliedHdmiRes = '1280x720';
                console.log('[DISPLAY] Salida HDMI/X11 ajustada automáticamente a 1280x720 para máxima fluidez.');
                if (curtainProc != null) {
                    try { process.kill(curtainProc.pid, 'SIGKILL'); } catch (e) {}
                    curtainProc = null;
                }
            } else if (stdout.indexOf('HDMI720=already') !== -1) {
                lastAppliedHdmiRes = '1280x720';
            }
        }
    });
}

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
            applyDisplayResolution720pIfNeeded(false);
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
    applyDisplayResolution720pIfNeeded(false);
    applyDisplayRotationIfNeeded(null, false);
}, 60000);

function killBackground() {
    if (procBackgroundImage != null) {
        try { process.kill(procBackgroundImage.pid, 'SIGKILL'); } catch (e) {}
        procBackgroundImage = null;
    }
}

var setBackground = function (callback) {
    if ((isArm || isLinux) && !isPlaying && !isScreenPoweredOff && !useDrmDirect && hasX11Display) {
        var bgPath = basePath + 'background.png';
        var fallbackStandby = (wallConfig && wallConfig.showStandbyScreen !== false && fs.existsSync(standbyFallbackImagePath)) ? standbyFallbackImagePath : '';
        var chosenBg = fs.existsSync(bgPath) ? bgPath : fallbackStandby;
        if (procBackgroundImage == null && chosenBg) {
            try {
                procBackgroundImage = spawn('feh', ['-x', '-q', '-F', chosenBg], {
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
var wallMasterState = { timePos: 0, duration: 0, playlistPos: 0, ts: 0, file: '' };
var wallSyncStatus = { active: false, mode: '', driftMs: 0, speed: 1, targetPos: 0, curPos: 0, playlistPos: 0, lastSyncAt: 0, lastError: '' };
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

function startWallSync(currentFile, isPlaylistMode) {
    stopWallSync();
    if (!isWallActive()) return;
    wallSyncStatus.active = true;
    wallSyncStatus.mode = wallConfig.syncMode + (wallConfig.masterIp ? '->' + wallConfig.masterIp : '');
    wallSyncStatus.speed = 1;

    wallSyncTimer = setInterval(function () {
        if (!isPlaying || !isWallActive() || wallSyncBusy) return;
        if (!isPlaylistMode && currentPlaylist.length !== 1) return;
        wallSyncBusy = true;

        mpvIpcRequest([
            ['get_property', 'time-pos'],
            ['get_property', 'duration'],
            ['get_property', 'playlist-pos']
        ], function (err, res) {
            if (err || !res || !res[1] || !res[2] || res[1].error !== 'success' || res[2].error !== 'success') {
                wallSyncBusy = false;
                if (err) wallSyncStatus.lastError = err.message;
                return;
            }
            var curPos = parseFloat(res[1].data);
            var duration = parseFloat(res[2].data);
            var curPlPos = (res[3] && res[3].error === 'success' && typeof res[3].data === 'number') ? res[3].data : 0;
            wallSyncStatus.playlistPos = curPlPos;

            if (isNaN(curPos) || isNaN(duration) || duration <= 1.5) {
                wallSyncBusy = false;
                return;
            }

            if (wallConfig.syncMode === 'master' && !wallConfig.masterIp) {
                wallMasterState = {
                    timePos: curPos,
                    duration: duration,
                    playlistPos: curPlPos,
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
                    if (isPlaylistMode && typeof body.playlistPos === 'number' && body.playlistPos !== curPlPos) {
                        console.log('[VIDEOWALL:SYNC] Alineando ítem de playlist #' + curPlPos + ' -> #' + body.playlistPos);
                        mpvIpcRequest([['set_property', 'playlist-pos', body.playlistPos]], function () {});
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

            if (isPlaylistMode && currentPlaylist.length > 1) {
                var totalCycleSec = 0;
                var offsets = [];
                for (var pi = 0; pi < currentPlaylist.length; pi++) {
                    var itemDur = Math.max(1, parseInt(currentPlaylist[pi].duration, 10) || 10);
                    offsets.push({ start: totalCycleSec, dur: itemDur });
                    totalCycleSec += itemDur;
                }
                if (totalCycleSec > 2) {
                    var cyclePos = (Date.now() / 1000) % totalCycleSec;
                    var wantIdx = 0;
                    for (var wi = 0; wi < offsets.length; wi++) {
                        if (cyclePos >= offsets[wi].start && cyclePos < (offsets[wi].start + offsets[wi].dur)) {
                            wantIdx = wi;
                            break;
                        }
                    }
                    if (wantIdx !== curPlPos) {
                        mpvIpcRequest([['set_property', 'playlist-pos', wantIdx]], function () {});
                        wallSyncBusy = false;
                        return;
                    }
                    var targetInItem = (cyclePos - offsets[wantIdx].start) % duration;
                    applyWallTargetDrift(curPos, duration, targetInItem);
                    wallSyncBusy = false;
                    return;
                }
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
    var curDims = getTargetVideoDims();
    console.log("[PLAYER:VIDEO] Reproduciendo: " + path.basename(fullPath) + (useDrmDirect ? " [DRM]" : "") + (curDims.use720p ? " [720p]" : "") + (mpvRotateDeg > 0 ? " [rot=" + mpvRotateDeg + "°]" : ""));

    var wallModeOn = isWallActive();
    var playerBin = ((wallModeOn || useDrmDirect || (currentPlaylist.length > 1 && hasMpv)) && hasMpv) ? 'mpv' : (hasOmxplayer ? 'omxplayer' : (hasMpv ? 'mpv' : 'omxplayer'));
    var playerArgs = [];
    var usedMpvPlaylist = false;
    var cfgVol = (wallConfig && typeof wallConfig.audioVolume === 'number') ? Math.max(0, Math.min(100, wallConfig.audioVolume)) : 100;
    var cfgMuted = Boolean(wallConfig && wallConfig.audioMuted);
    var cfgAudioOut = (wallConfig && wallConfig.audioOutput) ? wallConfig.audioOutput : 'auto';

    if (playerBin === 'omxplayer') {
        playerArgs = ['-b', '--no-osd', '--layer', '10000', '--no-keys'];
        if (cfgAudioOut === 'hdmi') playerArgs.push('--adev', 'hdmi');
        else if (cfgAudioOut === 'jack') playerArgs.push('--adev', 'local');
        if (cfgMuted || cfgVol === 0) {
            playerArgs.push('--vol', '-6000');
        } else if (cfgVol < 100) {
            var omxMb = Math.round(2000 * (Math.log(cfgVol / 100) / Math.LN10));
            playerArgs.push('--vol', String(omxMb));
        }
        if (mpvRotateDeg > 0) playerArgs.push('--orientation', String(mpvRotateDeg));
        if (currentPlaylist.length === 1) playerArgs.push('--loop');
        playerArgs.push(fullPath);
        activeMpvDriverInfo = 'omxplayer (Hardware VideoCore)';
    } else {
        try { if (fs.existsSync(mpvIpcSocketPath)) fs.unlinkSync(mpvIpcSocketPath); } catch (se) {}
        var maxDemuxBytes = isLowPowerPi ? '6M' : '16M';
        var maxBackBytes = isLowPowerPi ? '1M' : '4M';
        var voSetting = (wallConfig && wallConfig.videoOutputMode) ? wallConfig.videoOutputMode : 'auto';
        var mpvBaseArgs = [
            '--fs', '--no-osc', '--no-osd-bar', '--really-quiet',
            '--no-input-default-bindings', '--cursor-autohide=always', '--ontop',
            '--keep-open=no',
            '--scale=bilinear', '--cscale=bilinear', '--dscale=bilinear',
            '--dither-depth=no', '--deband=no',
            '--audio-fallback-to-null=yes',
            '--volume=' + cfgVol,
            '--mute=' + (cfgMuted ? 'yes' : 'no'),
            '--cache=yes', '--demuxer-max-bytes=' + maxDemuxBytes, '--demuxer-max-back-bytes=' + maxBackBytes,
            '--framedrop=vo',
            '--input-ipc-server=' + mpvIpcSocketPath
        ];
        if (mpvHasOption('audio-display')) {
            mpvBaseArgs.push('--audio-display=no');
        }
        if (mpvHasOption('vd-lavc-threads')) {
            mpvBaseArgs.push('--vd-lavc-threads=' + (isLowPowerPi ? '2' : '4'));
        }

        var chosenVoLabel = 'default';
        var chosenHwList = [];
        if (mpvSafeFallback) {
            if (hasX11Display && mpvHasVo('x11')) {
                mpvBaseArgs.push('--vo=x11');
                chosenVoLabel = 'x11-safe';
            }
            if (isLowPowerPi && mpvHasOption('sws-scaler')) mpvBaseArgs.push('--sws-scaler=fast-bilinear');
            chosenHwList = mpvFilterHwdecs(['v4l2m2m-copy', 'mmal-copy', 'auto']);
        } else if (useDrmDirect) {
            if (mpvHasVo('gpu') && mpvHasGpuCtx('drm')) {
                mpvBaseArgs.push(mpvHasVo('drm') ? '--vo=gpu,drm' : '--vo=gpu', '--gpu-context=drm');
                chosenVoLabel = 'drm-gpu';
            } else if (mpvHasVo('drm')) {
                mpvBaseArgs.push('--vo=drm');
                chosenVoLabel = 'drm';
            }
            if (isLowPowerPi && mpvRotateDeg === 0 && mpvHasOption('gpu-dumb-mode')) {
                mpvBaseArgs.push('--gpu-dumb-mode=yes');
            }
            chosenHwList = mpvFilterHwdecs(['drm', 'v4l2m2m', 'mmal', 'drm-copy', 'v4l2m2m-copy', 'auto-safe', 'auto']);
        } else if (voSetting === 'x11_light' || (voSetting === 'auto' && hasX11Display && mpvCaps.isSoftwareGl)) {
            var xVos = [];
            if (mpvHasVo('xv')) xVos.push('xv');
            if (mpvHasVo('x11')) xVos.push('x11');
            if (xVos.length > 0) {
                mpvBaseArgs.push('--vo=' + xVos.join(','));
                chosenVoLabel = xVos.join(',');
            }
            if (isLowPowerPi && mpvHasOption('sws-scaler')) {
                mpvBaseArgs.push('--sws-scaler=fast-bilinear');
            }
            if (isLowPowerPi && mpvHasOption('vd-lavc-skiploopfilter')) {
                mpvBaseArgs.push('--vd-lavc-skiploopfilter=nonref');
            }
            chosenHwList = mpvFilterHwdecs(['v4l2m2m-copy', 'mmal-copy', 'drm-copy', 'auto-copy', 'auto']);
        } else {
            if (mpvHasVo('gpu')) {
                mpvBaseArgs.push('--vo=gpu');
                chosenVoLabel = 'gpu';
            }
            if (hasWaylandDisplay && mpvHasGpuCtx('waylandegl')) {
                mpvBaseArgs.push('--gpu-context=waylandegl');
                chosenVoLabel = 'waylandegl';
            } else if (hasX11Display && mpvHasGpuCtx('x11egl')) {
                mpvBaseArgs.push('--gpu-context=x11egl');
                chosenVoLabel = 'x11egl';
            }
            if (isLowPowerPi) {
                if (mpvHasOption('opengl-es')) mpvBaseArgs.push('--opengl-es=yes');
                if (mpvRotateDeg === 0 && mpvHasOption('gpu-dumb-mode')) mpvBaseArgs.push('--gpu-dumb-mode=yes');
            }
            chosenHwList = mpvFilterHwdecs(['drm', 'drm-copy', 'v4l2m2m-copy', 'mmal-copy', 'auto-copy', 'auto-safe', 'auto']);
        }

        if (chosenHwList.length > 0) {
            mpvBaseArgs.push('--hwdec=' + chosenHwList.join(','));
        } else {
            mpvBaseArgs.push('--hwdec=auto');
        }
        activeMpvDriverInfo = 'mpv (vo:' + chosenVoLabel + ' | hw:' + (chosenHwList.length > 0 ? chosenHwList[0] : 'auto') + ')';

        if (mpvRotateDeg > 0) {
            mpvBaseArgs.push('--video-rotate=' + mpvRotateDeg);
        }
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
                var plFlags = isLowPowerPi ? ['--loop-playlist=inf'] : ['--prefetch-playlist=yes', '--loop-playlist=inf'];
                playerArgs = mpvBaseArgs.concat(plFlags, mpvPlaylistPaths);
                startSeamlessTelemetry(mpvTelemetryList);
                usedMpvPlaylist = true;
                console.log("[PLAYER:MPV] Modo playlist continua en ventana única (" + mpvPlaylistPaths.length + " videos | " + activeMpvDriverInfo + ").");
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
        if (wallModeOn && playerBin === 'mpv' && (currentPlaylist.length === 1 || usedMpvPlaylist)) {
            startWallSync(fullPath, usedMpvPlaylist);
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
            if (playerBin === 'mpv' && code !== 0 && elapsed < 1500 && !mpvSafeFallback) {
                mpvSafeFallback = true;
                console.warn("[PLAYER:MPV] Driver de video no soportado en esta Pi; activando fallback seguro X11...");
                return setTimeout(function () {
                    if (token === playbackToken && isPlaying) playCurrentIndex();
                }, 300);
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
        var dimsDisk = getTargetVideoDims();
        if (dimsDisk.convertEnabled) {
            convertExistingImages();
        }

        var curWallSig = getWallSignature();
        var curResTag = dimsDisk.use720p ? '_720p' : '';
        var videoFiles = diskFiles.filter(function (f) {
            if (!isVideoFile(f) || f.indexOf('.part') !== -1 || f.indexOf('temp_') !== -1) return false;
            if (/_\d+s\.mp4$/i.test(f)) {
                if (!dimsDisk.convertEnabled) return false;
                if (curResTag && f.indexOf(curResTag) === -1) return false;
                if (!curResTag && f.indexOf('_720p') !== -1) return false;
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
            console.log('[STARTUP] ¡' + videoFiles.length + ' video(s) encontrados en disco! Iniciando reproducción directa:');
            for (var p = 0; p < videoFiles.length; p++) {
                var rawDiskPath = path.join(contentBasePath, videoFiles[p]);
                if (dimsDisk.convertEnabled) {
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

var renderDeferCount = 0;
function processNextRender() {
    if (isRendering || renderQueue.length === 0) return;
    if (!bootGraceDone) {
        setTimeout(processNextRender, 3000);
        return;
    }
    var bpReason = getEncodingBackpressureReason();
    if (bpReason && renderDeferCount < 6) {
        renderDeferCount++;
        console.log('[RENDER] Posponiendo conversión 12s por ' + bpReason + '...');
        setTimeout(processNextRender, 12000);
        return;
    }
    renderDeferCount = 0;

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
    var targetFpsStr = String(dims.fps || 24);
    var wallCrop = isWallTileActive() ? (getWallCropFilter() + ',') : '';
    var vf = wallCrop +
             'scale=' + targetW + ':' + targetH + ':force_original_aspect_ratio=decrease,' +
             'scale=trunc(iw/2)*2:trunc(ih/2)*2,' +
             'pad=' + targetW + ':' + targetH + ':(' + targetW + '-iw)/2:(' + targetH + '-ih)/2:black,' +
             'setsar=1,format=yuv420p,loop=loop=-1:size=1:start=0,fps=' + targetFpsStr;

    var ffArgs = [
        '-nostdin', '-y', '-loglevel', 'error',
        '-i', file,
        '-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-vf', vf,
        '-c:v', 'libx264', '-threads', dims.threads, '-preset', 'ultrafast',
        '-profile:v', dims.profile, '-level', dims.level, '-pix_fmt', 'yuv420p',
        '-r', targetFpsStr, '-vsync', 'cfr', '-g', targetFpsStr, '-bf', '0',
        '-video_track_timescale', '12800',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-t', String(duration), '-movflags', '+faststart',
        tmpPath
    ];

    console.log('[RENDER] Convirtiendo imagen a video MP4 (' + duration + 's, ' + targetW + 'x' + targetH + ' @' + targetFpsStr + 'fps): ' + path.basename(file) + ' -> ' + path.basename(outPath));

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
    if (!getTargetVideoDims().convertEnabled) {
        if (typeof callback === 'function') callback(false);
        return;
    }
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
    if (!getTargetVideoDims().convertEnabled || !fs.existsSync(contentBasePath)) {
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
            var dimsImg = getTargetVideoDims();
            var resTagImg = dimsImg.use720p ? '_720p' : '';
            var wallTag = isWallTileActive() ? ('_' + getWallSignature()) : '';
            var expectedVideo = contentBasePath + baseNoExt + resTagImg + wallTag + '_' + defaultDuration + 's.mp4';
            if (fileExist(expectedVideo)) {
                try {
                    if (fs.statSync(expectedVideo).size > 4096) return next();
                    fs.unlinkSync(expectedVideo);
                } catch (e) {}
            }
            imgToVideo(contentBasePath + imgFile, baseNoExt + resTagImg + wallTag + '_' + defaultDuration + 's', defaultDuration, function () {
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
var optDeferCount = 0;

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
        return optimizedBasePath + 'opt_' + safeBase + '_' + st.size + '_' + st.mtime.getTime() + '_' + ori + '_' + dims.width + 'x' + dims.height + wallSuffix + '_p3.mp4';
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
    var force720Limit = (dims.mode === '720p');
    var limitLong = force720Limit ? 1280 : 1920;
    var limitShort = force720Limit ? 720 : 1080;
    var maxFps = 31;
    var maxBps = force720Limit ? 5000000 : 10000000;

    if (maxDim > limitLong || minDim > limitShort) return { needed: true, reason: 'resolucion ' + w + 'x' + h + ' -> ' + dims.width + 'x' + dims.height };
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
    var bpReason = getEncodingBackpressureReason();
    if (bpReason && optDeferCount < 8) {
        optDeferCount++;
        console.log('[OPT:VIDEO] Posponiendo normalización 20s por ' + bpReason + '...');
        setTimeout(processNextVideoOpt, 20000);
        return;
    }
    optDeferCount = 0;

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
        var targetFps = dims.fps || (dims.use720p ? 24 : 25);
        var wallCrop = isWallTileActive() ? (getWallCropFilter() + ',') : '';
        var padFilter = 'pad=' + maxW + ':' + maxH + ':(' + maxW + '-iw)/2:(' + maxH + '-ih)/2:black,';
        var vf = wallCrop +
                 'scale=' + maxW + ':' + maxH + ':force_original_aspect_ratio=decrease,' +
                 'scale=trunc(iw/2)*2:trunc(ih/2)*2,' + padFilter + 'setsar=1,format=yuv420p';

        var tmpPath = optimizedBasePath + 'temp_' + Date.now() + '_' + path.basename(outPath);
        if (fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
        }

        var ffArgs = ['-nostdin', '-y', '-loglevel', 'error', '-i', srcPath];
        var durStr = (info.duration && info.duration > 0) ? info.duration.toFixed(3) : '15.000';
        if (!info.hasAudio) {
            ffArgs.push('-f', 'lavfi', '-t', durStr, '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
        }
        ffArgs.push(
            '-vf', vf,
            '-c:v', 'libx264',
            '-threads', dims.threads,
            '-preset', dims.preset || 'ultrafast',
            '-profile:v', dims.profile,
            '-level', dims.level,
            '-pix_fmt', 'yuv420p',
            '-r', String(targetFps),
            '-vsync', 'cfr',
            '-g', String(targetFps),
            '-bf', '0',
            '-video_track_timescale', '12800',
            '-crf', dims.crf,
            '-maxrate', dims.maxRate,
            '-bufsize', dims.bufSize
        );
        if (info.hasAudio) {
            ffArgs.push('-map', '0:v:0', '-map', '0:a:0', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k');
        } else {
            ffArgs.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-shortest');
        }
        ffArgs.push('-movflags', '+faststart', tmpPath);

        console.log('[OPT:VIDEO] Normalizando video a ' + maxW + 'x' + maxH + ' @' + targetFps + 'fps (' + check.reason + '): ' + path.basename(srcPath));

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
    if (!getTargetVideoDims().convertEnabled) return;
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

        var dimsGc = getTargetVideoDims();
        var wallTagImg = isWallTileActive() ? ('_' + getWallSignature()) : '';
        var resTagGc = dimsGc.use720p ? '_720p' : '';
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

                if (!dimsGc.convertEnabled) continue;

                if (isImg(safeName) || isImg(itm.content)) {
                    var dur = parseInt(itm.length, 10);
                    if (isNaN(dur) || dur <= 0) dur = 10;
                    var imgVid = safeName.replace(/\.[^/.]+$/, '') + resTagGc + wallTagImg + '_' + dur + 's.mp4';
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
            if (dimsGc.convertEnabled && resolvedBlockItems.length > 1) {
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
    var dimsSearch = getTargetVideoDims();

    if (isImg(safeContent) || isImg(contentToSearch)) {
        var imgSource = fileExist(contentBasePath + safeContent) ? (contentBasePath + safeContent) :
                        (fileExist(contentBasePath + contentToSearch) ? (contentBasePath + contentToSearch) : null);

        if (!dimsSearch.convertEnabled) {
            if (imgSource) return path.basename(imgSource);
            if (!ftpWorking && respuesta) checkContentsFTP();
            return false;
        }

        var baseNoExt = safeContent.replace(/\.[^/.]+$/, "");
        var resTagImg = dimsSearch.use720p ? '_720p' : '';
        var wallTagImg = isWallTileActive() ? ('_' + getWallSignature()) : '';
        var videoBase = baseNoExt + resTagImg + wallTagImg + '_' + duration + 's';
        var videoName = videoBase + '.mp4';
        var videoPath = contentBasePath + videoName;

        if (fileExist(videoPath)) {
            try {
                if (fs.statSync(videoPath).size > 4096) return videoName;
                fs.unlinkSync(videoPath);
            } catch (e) {}
        }

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

    if (dimsSearch.convertEnabled && isVideoFile(targetPath) && (isArm || isLinux)) {
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
    if (!getTargetVideoDims().convertEnabled) return;
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
    if (!getTargetVideoDims().convertEnabled) return;
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
        var targetFps = dims.fps || (dims.use720p ? 24 : 25);
        var tmpPath = seamlessBasePath + 'temp_' + Date.now() + '_' + path.basename(outPath);
        var concatListPath = null;
        var ffArgs = [];

        var firstFps = probed[0] ? (probed[0].fps || 24) : 24;
        var canFastCopy = probed.every(function (pi) {
            return pi.videoCodec === 'h264' &&
                   (pi.pixFmt === 'yuv420p' || pi.pixFmt === 'yuvj420p') &&
                   pi.width === targetW && pi.height === targetH &&
                   pi.fps >= 20 && pi.fps <= 31 &&
                   Math.abs(pi.fps - firstFps) <= 1.2 &&
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

        if (!canFastCopy && isLowPowerPi && !isWallTileActive()) {
            console.log('[SEAMLESS] Omitiendo recodificación pesada en Pi 3B+ para bloque ' + idBlock + '; mpv reproducirá la lista nativa sin sobrecargar CPU.');
            failedSeamlessHashes[blockHash] = true;
            isConcatenating = false;
            activeSeamlessHash = '';
            return;
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
                    'setsar=1,fps=' + targetFps + ',format=yuv420p[v' + i + ']'
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
                '-r', String(targetFps), '-vsync', 'cfr', '-g', String(targetFps), '-bf', '0',
                '-video_track_timescale', '12800',
                '-crf', dims.crf, '-maxrate', dims.maxRate, '-bufsize', dims.bufSize,
                '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-movflags', '+faststart',
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
    var dimsPlay = getTargetVideoDims();
    var allItemsAreVideos = filesToPlay.length > 1 && filesToPlay.every(function (it) {
        return isVideoFile(it.file);
    });

    if (dimsPlay.convertEnabled && allItemsAreVideos) {
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
    if (syncScreenPowerSchedule()) {
        return;
    }
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
    applyAudioSettings();
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

function parseThrottleHex(rawStr) {
    var m = /throttled=(0x[0-9a-f]+)/i.exec(String(rawStr || ''));
    var hexStr = m ? m[1] : String(rawStr || '').trim();
    var val = parseInt(hexStr, 16);
    if (isNaN(val)) {
        return { raw: '0x0', ok: true, underVoltageNow: false, underVoltagePast: false, throttledNow: false, label: 'OK' };
    }
    var uvNow = Boolean(val & 0x1);
    var capNow = Boolean(val & 0x2);
    var thNow = Boolean(val & 0x4);
    var uvPast = Boolean(val & 0x10000);
    var thPast = Boolean(val & 0x40000);
    var labels = [];
    if (uvNow) labels.push('Bajo voltaje AHORA');
    else if (uvPast) labels.push('Bajo voltaje previo');
    if (thNow) labels.push('Throttling térmico');
    else if (thPast) labels.push('Throttling previo');
    if (capNow) labels.push('Frecuencia limitada');
    return {
        raw: hexStr,
        ok: (!uvNow && !thNow && !capNow),
        underVoltageNow: uvNow,
        underVoltagePast: uvPast,
        throttledNow: thNow,
        label: labels.length > 0 ? labels.join(' • ') : 'OK (Voltaje estable)'
    };
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
            var pending = 3;
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
                        if (freeDiskMb < 600 && (Date.now() - lastGcAt) > 300000) {
                            garbageCollectUnusedMedia(true);
                        }
                    }
                }
                doneOne();
            });

            exec("/usr/bin/vcgencmd get_throttled 2>/dev/null || /opt/vc/bin/vcgencmd get_throttled 2>/dev/null || true", function (err, stdout) {
                if (!err && stdout && String(stdout).trim()) {
                    throttleStatus = parseThrottleHex(stdout);
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

        var dimsDl = getTargetVideoDims();
        if (dimsDl.convertEnabled) {
            if (isImg(content.content)) {
                var imgDuration = parseInt(content.length, 10);
                if (isNaN(imgDuration) || imgDuration <= 0) imgDuration = 10;
                var baseImgName = normalizeName(content.content).replace(/\.[^/.]+$/, "");
                var resTagDl = dimsDl.use720p ? '_720p' : '';
                var wallTagDl = isWallTileActive() ? ('_' + getWallSignature()) : '';
                imgToVideo(content.contentPath, baseImgName + resTagDl + wallTagDl + '_' + imgDuration + 's', imgDuration);
            } else if (isVideoFile(content.contentPath)) {
                scheduleVideoOptimization(content.contentPath);
            }
        }

        var qIdx = getIndex(FTPcontents, content);
        if (qIdx !== -1) FTPcontents.splice(qIdx, 1);

        checkSchedule();
        if (dimsDl.convertEnabled) {
            setTimeout(prebuildAllScheduleBlocks, 1500);
        }
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
    if (activePlayerBin === 'omxplayer' && hasRaspi2png) {
        cmd = 'raspi2png -p "' + outPath + '"';
    } else if (hasWaylandDisplay && hasGrim) {
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

var lastAppliedHostname = '';
var hostnameSyncBusy = false;
function sanitizeHostname(rawStr) {
    if (!rawStr) return '';
    var s = String(rawStr);
    if (typeof s.normalize === 'function') {
        s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    s = s.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (s.length > 63) {
        s = s.slice(0, 63).replace(/-+$/g, '');
    }
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return '';
    return s;
}

function resolveManagerHostname(data) {
    if (!data || typeof data !== 'object') return { hostname: '', label: '' };
    var rawDisp = data.nameDisplay || data.displayName || data.nombreDisplay || data.urpName || data.name || data.nombre || data.screenName || data.title || data.alias || data.display || '';
    var rawStore = data.storeName || data.nombreSucursal || data.sucursal || data.branchName || data.localName || data.local || data.tienda || '';
    var explicitHost = data.hostname || data.hostName || '';
    var label = rawStore && rawDisp && String(rawDisp).toLowerCase().indexOf(String(rawStore).toLowerCase()) === -1
        ? (rawStore + ' - ' + rawDisp)
        : (rawDisp || rawStore || explicitHost || '');

    var candidate = '';
    if (explicitHost) {
        candidate = sanitizeHostname(explicitHost);
    } else if (rawStore && rawDisp) {
        var normDisp = sanitizeHostname(rawDisp);
        var normStore = sanitizeHostname(rawStore);
        candidate = (normDisp.indexOf(normStore) === 0) ? normDisp : sanitizeHostname(normStore + '-' + normDisp);
    } else if (rawDisp) {
        candidate = sanitizeHostname(rawDisp);
    } else if (rawStore && (data.idDisplay || data.idURP)) {
        candidate = sanitizeHostname(rawStore + '-d' + (data.idDisplay || data.idURP));
    }

    if (!candidate && (data.idDisplay || data.idURP)) {
        var parts = ['urp'];
        if (data.idStore) parts.push('s' + parseInt(data.idStore, 10));
        if (data.idDisplay) parts.push('d' + parseInt(data.idDisplay, 10));
        else if (data.idURP) parts.push('u' + parseInt(data.idURP, 10));
        candidate = sanitizeHostname(parts.join('-'));
    }
    return { hostname: candidate, label: String(label || candidate || '').trim() };
}

function syncSystemAndTailscaleHostname(targetHost) {
    if (!isArm && !isLinux) return;
    if (process.env.URP_AUTO_HOSTNAME === '0') return;
    var cleanHost = sanitizeHostname(targetHost);
    if (!cleanHost || hostnameSyncBusy) return;
    var currentOsHost = '';
    try { currentOsHost = sanitizeHostname(osMod.hostname()); } catch (e) {}
    if (cleanHost === lastAppliedHostname && cleanHost === currentOsHost) return;

    hostnameSyncBusy = true;
    var cmd = '';
    if (cleanHost !== currentOsHost) {
        cmd += 'if command -v hostnamectl >/dev/null 2>&1; then sudo -n hostnamectl set-hostname "' + cleanHost + '" 2>/dev/null || hostnamectl set-hostname "' + cleanHost + '" 2>/dev/null || true; fi; ';
    }
    cmd += 'if command -v tailscale >/dev/null 2>&1; then sudo -n tailscale set --hostname="' + cleanHost + '" 2>/dev/null || tailscale set --hostname="' + cleanHost + '" 2>/dev/null || true; fi';

    exec(cmd, { timeout: 8000 }, function () {
        hostnameSyncBusy = false;
        lastAppliedHostname = cleanHost;
        console.log('[HOSTNAME] Sincronizado desde Manager -> ' + cleanHost + ' (Linux + Tailscale)');
    });
}

var tailscaleEnrollBusy = false;
var tailscaleEnrollAttempted = false;
function readTailscaleAuthKey(mgrAuthKey) {
    var candidates = [
        mgrAuthKey,
        process.env.TS_AUTHKEY,
        process.env.URP_TS_AUTHKEY
    ];
    var keyFiles = [
        basePath + '.tailscale_key',
        '/boot/firmware/urp_tailscale_key.txt',
        '/boot/urp_tailscale_key.txt'
    ];
    for (var f = 0; f < keyFiles.length; f++) {
        try {
            if (fs.existsSync(keyFiles[f])) {
                candidates.push(fs.readFileSync(keyFiles[f], 'utf8'));
            }
        } catch (e) {}
    }
    for (var i = 0; i < candidates.length; i++) {
        var k = String(candidates[i] || '').trim();
        if (/^tskey-[a-zA-Z0-9_-]{12,}$/.test(k)) return k;
    }
    return '';
}

function ensureTailscaleEnrolled(targetHost, mgrAuthKey) {
    if (!isArm && !isLinux) return;
    if (tailscaleEnrollBusy || tailscaleEnrollAttempted) return;
    if (getTailscaleIp()) return;
    var authKey = readTailscaleAuthKey(mgrAuthKey);
    if (!authKey) return;

    tailscaleEnrollBusy = true;
    tailscaleEnrollAttempted = true;
    var cleanHost = sanitizeHostname(targetHost) || sanitizeHostname(osMod.hostname()) || 'urp-player';
    console.log('[TAILSCALE] Intentando alta automática con hostname "' + cleanHost + '"...');

    var cmd = 'if ! command -v tailscale >/dev/null 2>&1; then curl -fsSL https://tailscale.com/install.sh | sudo -n sh; fi && ' +
              '(sudo -n systemctl enable --now tailscaled >/dev/null 2>&1 || true) && ' +
              '(sudo -n tailscale up --auth-key="' + authKey + '" --hostname="' + cleanHost + '" --accept-dns=true || tailscale up --auth-key="' + authKey + '" --hostname="' + cleanHost + '" --accept-dns=true)';

    exec(cmd, { timeout: 120000 }, function (err) {
        tailscaleEnrollBusy = false;
        var tsIp = getTailscaleIp();
        if (tsIp) {
            console.log('[TAILSCALE] Equipo dado de alta automáticamente! IP remota: ' + tsIp + ' (:' + URPPort + ')');
        } else if (err) {
            console.warn('[TAILSCALE] No se pudo completar alta automática:', err.message);
        }
    });
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

var lastExecutedRemoteCmdId = '';
var liveSessionUntilMs = 0;
var liveSessionIntervalId = null;
var liveStepInFlight = false;

function buildCompactRemoteState(callback) {
    loadWallConfig();
    var compose = function (pl) {
        var dimsNow = getTargetVideoDims();
        var effOrient = readHdmiRotateFromConfig();
        callback({
            version: URPVersion,
            model: piModelStr,
            hostname: osMod.hostname(),
            managerName: URPdata.managerName || '',
            totalRamMB: totalRamMB,
            displayBackend: useDrmDirect ? 'DRM/KMS' : (hasWaylandDisplay ? 'Wayland' : 'X11'),
            playerDriver: activeMpvDriverInfo || (hasOmxplayer ? 'omxplayer' : 'mpv'),
            targetResolution: !dimsNow.convertEnabled ? ('Directo' + (dimsNow.use720p && wallConfig.hdmi720p !== false ? ' • HDMI 720p' : ' (Original)')) : (dimsNow.mode === 'auto' ? ('Inteligente' + (dimsNow.use720p ? ' (720p img / H.264 directo)' : ' (1080p)')) : (dimsNow.width + 'x' + dimsNow.height)),
            effectiveOrientation: (effOrient !== null) ? effOrient : (wallConfig.orientation || 0),
            ip: URPdata.URPIpAddress || '',
            tailscaleIp: getTailscaleIp(),
            mac: macAdd,
            uptimeSec: Math.round(process.uptime()),
            osUptimeSec: Math.round(osMod.uptime()),
            freeSpace: URPFreeSpace,
            freeDiskMb: freeDiskMb,
            temperature: temperature,
            cpuUsage: cpuUsage,
            memPercentUsed: memPercentUsed,
            throttleStatus: throttleStatus,
            screenPoweredOff: isScreenPoweredOff,
            nowPlayingId: URPNowPlaying,
            blockPlaying: blockPlaying,
            player: pl,
            scheduleSummary: buildScheduleSummaryForStatus(),
            wallActive: isWallActive(),
            wallConfig: getWallConfigPublic(),
            queues: {
                ftp: FTPcontents.length,
                render: renderQueue.length + (isRendering ? 1 : 0),
                videoOpt: videoOptQueue.length + (isOptimizingVideo ? 1 : 0)
            }
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
            compose({
                active: Boolean(isPlaying),
                bin: activePlayerBin,
                file: fname || (filesPlaying[0] || ''),
                timePos: pos,
                duration: dur,
                paused: paused
            });
        });
    } else {
        compose({
            active: Boolean(isPlaying),
            bin: activePlayerBin || (activeFehProcess ? 'imagen' : 'idle'),
            file: filesPlaying[0] || '',
            timePos: 0,
            duration: 0,
            paused: false
        });
    }
}

function sendRemoteAckToManager(extraPayload, cb) {
    if (!URPdata || !URPdata.idDisplay || !macAdd) {
        if (typeof cb === 'function') cb();
        return;
    }
    var payload = Object.assign({
        idDisplay: URPdata.idDisplay,
        macAddress: macAdd
    }, extraPayload || {});
    httpRequest({
        url: 'http://' + baseUrl + '/ws/ackURPControl.php',
        method: 'POST',
        json: true,
        timeout: 6000,
        body: payload
    }, function () {
        if (typeof cb === 'function') cb();
    });
}

function applyRemoteManagerConfig(cfg, cfgVersion) {
    if (!cfg || typeof cfg !== 'object') return;
    var verNum = parseInt(cfgVersion, 10) || 0;
    loadWallConfig();
    if (verNum > 0 && verNum <= (wallConfig.remoteConfigVersion || 0)) return;

    var dimsBefore = getTargetVideoDims();
    var prevRot = wallConfig.orientation;
    var prevResMode = wallConfig.resolutionMode;
    var prevVoMode = wallConfig.videoOutputMode || 'auto';
    var patch = { remoteConfigVersion: Math.max(verNum, (wallConfig.remoteConfigVersion || 0) + 1) };
    var needPlayerRestart = false;
    var needAudioApply = false;
    var needPowerApply = false;

    if (cfg.resolutionMode === 'auto' || cfg.resolutionMode === '720p' || cfg.resolutionMode === '1080p' || cfg.resolutionMode === 'direct') {
        if (cfg.resolutionMode !== wallConfig.resolutionMode) needPlayerRestart = true;
        patch.resolutionMode = cfg.resolutionMode;
    }
    if (cfg.hdmi720p !== undefined) {
        var nextHdmi = Boolean(cfg.hdmi720p);
        if (nextHdmi !== wallConfig.hdmi720p) needPlayerRestart = true;
        patch.hdmi720p = nextHdmi;
    }
    if (cfg.showStandbyScreen !== undefined) {
        patch.showStandbyScreen = Boolean(cfg.showStandbyScreen);
    }
    if (cfg.orientation !== undefined) {
        var oVal = parseInt(cfg.orientation, 10);
        if ([0, 1, 2, 3].indexOf(oVal) !== -1 && oVal !== wallConfig.orientation) {
            patch.orientation = oVal;
            var rotRes = writeHdmiRotateToConfig(oVal);
            patch.orientationOverride = !(rotRes && rotRes.ok);
            needPlayerRestart = true;
        }
    }
    if (cfg.videoOutputMode === 'auto' || cfg.videoOutputMode === 'x11_light' || cfg.videoOutputMode === 'gpu_egl' || cfg.videoOutputMode === 'drm') {
        if (cfg.videoOutputMode !== prevVoMode) needPlayerRestart = true;
        patch.videoOutputMode = cfg.videoOutputMode;
        patch.drmMode = (cfg.videoOutputMode === 'drm');
    }

    if (cfg.audioVolume !== undefined) {
        var v = Math.max(0, Math.min(100, parseInt(cfg.audioVolume, 10) || 0));
        if (v !== wallConfig.audioVolume) needAudioApply = true;
        patch.audioVolume = v;
    }
    if (cfg.audioMuted !== undefined) {
        var m = Boolean(cfg.audioMuted);
        if (m !== wallConfig.audioMuted) needAudioApply = true;
        patch.audioMuted = m;
    }
    if (cfg.audioOutput === 'auto' || cfg.audioOutput === 'hdmi' || cfg.audioOutput === 'jack') {
        if (cfg.audioOutput !== wallConfig.audioOutput) needAudioApply = true;
        patch.audioOutput = cfg.audioOutput;
    }

    if (cfg.screenScheduleEnabled !== undefined) {
        patch.screenScheduleEnabled = Boolean(cfg.screenScheduleEnabled);
        needPowerApply = true;
    }
    if (cfg.screenOnTime !== undefined) {
        patch.screenOnTime = sanitizeTimeHHMM(cfg.screenOnTime, wallConfig.screenOnTime);
        needPowerApply = true;
    }
    if (cfg.screenOffTime !== undefined) {
        patch.screenOffTime = sanitizeTimeHHMM(cfg.screenOffTime, wallConfig.screenOffTime);
        needPowerApply = true;
    }

    if (cfg.enabled !== undefined) {
        patch.enabled = Boolean(cfg.enabled);
        needPlayerRestart = true;
    }
    if (cfg.activationMode === 'server' || cfg.activationMode === 'local') {
        patch.activationMode = cfg.activationMode;
        needPlayerRestart = true;
    }
    if (cfg.mode === 'tile' || cfg.mode === 'mirror') {
        patch.mode = cfg.mode;
        needPlayerRestart = true;
    }
    if (cfg.rows !== undefined) {
        patch.rows = Math.max(1, Math.min(32, parseInt(cfg.rows, 10) || 1));
        needPlayerRestart = true;
    }
    if (cfg.cols !== undefined) {
        patch.cols = Math.max(1, Math.min(32, parseInt(cfg.cols, 10) || 1));
        needPlayerRestart = true;
    }
    if (cfg.screenId !== undefined) {
        patch.screenId = Math.max(1, Math.min(999, parseInt(cfg.screenId, 10) || 1));
        needPlayerRestart = true;
    }

    saveWallConfigPartial(patch);
    console.log('[REMOTE] Configuración v' + patch.remoteConfigVersion + ' recibida y aplicada desde tbee.tv.');

    if (needAudioApply) applyAudioSettings();
    if (needPowerApply) {
        manualScreenOffOverride = null;
        syncScreenPowerSchedule();
    }
    if (needPlayerRestart) {
        mpvSafeFallback = false;
        lastAppliedHdmiRes = '';
        applyDisplayResolution720pIfNeeded(true);
        applyDisplayRotationIfNeeded(null, true);
        var dimsNow = getTargetVideoDims();
        if ((dimsBefore.convertEnabled || dimsNow.convertEnabled) &&
            (wallConfig.resolutionMode !== prevResMode || (wallConfig.orientation !== prevRot && (prevRot % 2 !== wallConfig.orientation % 2)))) {
            clearWallDerivedCaches();
        }
        blockPlaying = 0;
        stopOmx(function () { setTimeout(function () { checkSchedule(); }, 250); });
    }
    sendRemoteAckToManager({ appliedConfigVersion: patch.remoteConfigVersion });
}

function executeRemoteManagerCommand(cmd, cmdId) {
    if (!cmd || !cmdId) return;
    var cleanId = String(cmdId).trim();
    if (!cleanId || cleanId === lastExecutedRemoteCmdId) return;
    lastExecutedRemoteCmdId = cleanId;
    console.log('[REMOTE:CMD] Ejecutando comando desde tbee.tv: ' + cmd);

    if (cmd === 'reboot') {
        sendRemoteAckToManager({ executedCommandId: cleanId, ok: true }, function () {
            setTimeout(resetURP, 250);
        });
        return;
    }
    if (cmd === 'shutdown') {
        sendRemoteAckToManager({ executedCommandId: cleanId, ok: true }, function () {
            setTimeout(shutdownURP, 250);
        });
        return;
    }

    if (cmd === 'toggle_pause' && isPlaying && activePlayerProcess && activePlayerBin === 'mpv' && fs.existsSync(mpvIpcSocketPath)) {
        mpvIpcRequest([['cycle', 'pause']], function () {});
    } else if (cmd === 'next_item' && isPlaying && currentPlaylist.length > 0) {
        if (activePlayerProcess && activePlayerBin === 'mpv' && currentPlaylist.length > 1 && fs.existsSync(mpvIpcSocketPath)) {
            mpvIpcRequest([['playlist-next', 'force']], function (err) {
                if (err) { currentMediaIndex++; playCurrentIndex(); }
            });
        } else {
            currentMediaIndex++;
            playCurrentIndex();
        }
    } else if (cmd === 'restart_player') {
        blockPlaying = 0;
        stopOmx(function () { setTimeout(function () { checkSchedule(); }, 250); });
    } else if (cmd === 'ota_update') {
        checkGithubOTA(true);
    } else if (cmd === 'gc') {
        garbageCollectUnusedMedia(false);
    } else if (cmd === 'clean_logs') {
        execCleanLogs();
    } else if (cmd === 'delete_contents') {
        deleteContentFiles();
    } else if (cmd === 'screen_on') {
        manualScreenOffOverride = false;
        applyScreenPowerState(true);
    } else if (cmd === 'screen_off') {
        manualScreenOffOverride = true;
        applyScreenPowerState(false);
    } else if (cmd === 'screen_auto') {
        manualScreenOffOverride = null;
        syncScreenPowerSchedule();
    }

    sendRemoteAckToManager({ executedCommandId: cleanId, ok: true });
}

function stopLiveSessionLoop() {
    liveSessionUntilMs = 0;
    if (liveSessionIntervalId) {
        clearInterval(liveSessionIntervalId);
        liveSessionIntervalId = null;
    }
}

function syncLiveSessionStep() {
    if (Date.now() > liveSessionUntilMs) {
        stopLiveSessionLoop();
        return;
    }
    if (liveStepInFlight || !URPdata || !URPdata.idDisplay || !macAdd) return;
    liveStepInFlight = true;

    captureLivePreview(function (ok, previewPath) {
        var previewB64 = '';
        try {
            if (ok && fs.existsSync(previewPath)) {
                var st = fs.statSync(previewPath);
                if (st.size > 512 && st.size <= 245000) {
                    previewB64 = fs.readFileSync(previewPath).toString('base64');
                }
            }
        } catch (e) {}

        buildCompactRemoteState(function (stateObj) {
            httpRequest({
                url: 'http://' + baseUrl + '/ws/urpLive.php',
                method: 'POST',
                json: true,
                timeout: 8000,
                body: {
                    idDisplay: URPdata.idDisplay,
                    macAddress: macAdd,
                    previewJpgBase64: previewB64,
                    logsText: recentLogs.slice(-100).join('\n'),
                    state: stateObj
                }
            }, function (err, resp, d) {
                liveStepInFlight = false;
                if (err || !resp || resp.statusCode !== 200 || !d || typeof d !== 'object') return;
                if (d.liveActive === false) {
                    stopLiveSessionLoop();
                } else if (d.liveActive === true) {
                    liveSessionUntilMs = Date.now() + 90000;
                }
                if (d.urpConfig && d.urpConfigVersion) {
                    applyRemoteManagerConfig(d.urpConfig, d.urpConfigVersion);
                }
                if (d.urpCommand && d.urpCommandId) {
                    executeRemoteManagerCommand(d.urpCommand, d.urpCommandId);
                }
            });
        });
    });
}

function startOrExtendLiveSession() {
    liveSessionUntilMs = Date.now() + 120000;
    if (!liveSessionIntervalId) {
        syncLiveSessionStep();
        liveSessionIntervalId = setInterval(syncLiveSessionStep, 3500);
    }
}

function formatManagerIpField() {
    var tsIp = String(getTailscaleIp() || '').trim();
    if (tsIp) return tsIp;
    return String(URPdata.URPIpAddress || '').trim();
}

function callWS() {
    getIpAddress(function () {
        getURPHardData(function () {
            buildCompactRemoteState(function (urpStateObj) {
                var date = new Date();
                var options = {
                    url: 'http://' + baseUrl + '/ws/URP.php',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    json: true,
                    timeout: 10000,
                    body: {
                        macAddress: macAdd,
                        ip: formatManagerIpField(),
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
                        version: URPVersion,
                        urpState: urpStateObj
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

                            var mgrHostInfo = resolveManagerHostname(data);
                            if (mgrHostInfo.label) URPdata.managerName = mgrHostInfo.label;
                            if (mgrHostInfo.hostname) {
                                URPdata.managerHostname = mgrHostInfo.hostname;
                                syncSystemAndTailscaleHostname(mgrHostInfo.hostname);
                            }
                            ensureTailscaleEnrolled(mgrHostInfo.hostname, data.tailscaleAuthKey || data.tsAuthKey || '');

                            if (data.cleanLogs == 1 || data.cleanLogs === '1') cleanLogs();
                            if (data.uploadLogs == 1 || data.uploadLogs === '1') uploadLogs();
                            if (data.screenshot == 1 || data.screenshot === '1') takeScreenshot();
                            if (data.background == 1 || data.background === '1') downloadBackgroundFile();

                            // Integración nativa tbee.tv <-> Panel Remoto (sin Tailscale)
                            if (data.urpConfig && data.urpConfigVersion) {
                                applyRemoteManagerConfig(data.urpConfig, data.urpConfigVersion);
                            }
                            if (data.urpCommand && data.urpCommandId) {
                                executeRemoteManagerCommand(data.urpCommand, data.urpCommandId);
                            }
                            if (data.urpLiveSession === true) {
                                startOrExtendLiveSession();
                            }

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
                                        if (getTargetVideoDims().convertEnabled) {
                                            setTimeout(prebuildAllScheduleBlocks, 2000);
                                        }
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
    noOptNeededMap = {};
    failedOptMap = {};
    clearDirectoryFiles(optimizedBasePath);
    clearDirectoryFiles(seamlessBasePath);
    try {
        if (fs.existsSync(contentBasePath)) {
            var cfiles = fs.readdirSync(contentBasePath);
            for (var i = 0; i < cfiles.length; i++) {
                if (/_W[TM][^_]*_.*_\d+s\.mp4$/i.test(cfiles[i]) || /_WM_\d+s\.mp4$/i.test(cfiles[i]) || /_720p.*_\d+s\.mp4$/i.test(cfiles[i])) {
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
        '.wrap{max-width:1080px;margin:0 auto}' +
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
        '.pbarWrap{height:6px;background:#030712;border-radius:6px;overflow:hidden;margin-top:7px;border:1px solid #1f2937}' +
        '.pbarFill{height:100%;width:0%;background:#3b82f6;transition:width .4s ease}' +
        '.liveHead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}' +
        '.liveBadge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;letter-spacing:.05em;background:#1e293b;color:#94a3b8}' +
        '.liveBadge.on{background:#065f46;color:#6ee7b7}' +
        '.hide{display:none!important}' +
        '.msg{padding:10px 12px;border-radius:9px;font-size:12px;margin-bottom:14px;border:1px solid #1e40af;background:#0f172a;color:#bfdbfe;display:none}' +
        '.msg.err{border-color:#991b1b;background:#1f1215;color:#fecaca} .msg.ok{border-color:#065f46;background:#091f18;color:#a7f3d0}' +
        '.fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:12px}' +
        'label.lbl{display:block;font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:5px}' +
        'select,input[type=number],input[type=text],input[type=password],input[type=time]{width:100%;background:#030712;border:1px solid #334155;border-radius:8px;padding:8px 10px;color:#f8fafc;font-size:13px}' +
        'input[type=range]{width:100%;accent-color:#2563eb}' +
        '.stepRow{display:flex;gap:6px;align-items:center} .stepRow button{min-width:36px;padding:8px 10px}' +
        '.presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px} .pbtn{padding:6px 10px;font-size:11px;background:#0f172a;border:1px solid #334155}' +
        '.pbtn.on{background:#2563eb;border-color:#3b82f6}' +
        '.mwrap{overflow-x:auto;padding:8px 0}' +
        '.mgrid{display:inline-grid;gap:6px;background:#030712;padding:10px;border-radius:10px;border:1px solid #1f2937}' +
        '.mcell{min-width:54px;height:42px;border-radius:7px;border:1px solid #334155;background:#111827;color:#cbd5e1;font-size:11px;font-weight:700;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer}' +
        '.mcell small{font-size:9px;font-weight:400;color:#64748b} .mcell.active{background:#2563eb;border-color:#60a5fa;color:#fff} .mcell.active small{color:#dbeafe}' +
        '.warnBox{padding:9px 11px;border-radius:8px;background:#291d09;border:1px solid #b45309;color:#fde68a;font-size:12px;margin-bottom:12px;display:none;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}' +
        '.chkRow{display:flex;align-items:center;gap:8px;font-size:13px;color:#e2e8f0;padding-top:6px}' +
        '.agendaBlk{background:#030712;border:1px solid #1f2937;border-radius:10px;padding:10px 12px;margin-top:8px}' +
        '.agendaHead{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;font-size:12px;font-weight:700;color:#e2e8f0}' +
        '.agendaRow{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;border-top:1px solid #111827;font-size:12px;color:#cbd5e1;flex-wrap:wrap}' +
        '.tag{display:inline-block;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;background:#1e293b;color:#94a3b8}' +
        '.tag.on{background:#065f46;color:#6ee7b7} .tag.wait{background:#78350f;color:#fde68a}' +
        '</style></head><body><div class="wrap">' +
        '<div class="top"><div><h1><span id="titleMain">URP Signage Monitor</span> <span id="ver"></span></h1><div class="sub" id="meta">Cargando...</div></div>' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div class="sub" id="conn"></div><button id="btnLogout" class="b-ghost hide" style="padding:6px 10px;font-size:11px">Cerrar sesión</button></div></div>' +
        '<div id="msgBox" class="msg"></div>' +
        '<div id="hwAlert" class="warnBox"></div>' +

        '<div id="viewLogin" class="hide"><div class="card" style="max-width:420px;margin:40px auto">' +
        '<h2>Acceso Protegido (:8090)</h2>' +
        '<div class="sub" style="margin-bottom:12px">Ingresá el PIN del panel para ver o administrar esta Raspberry Pi.</div>' +
        '<label class="lbl" for="loginPin">PIN del panel</label>' +
        '<input type="password" id="loginPin" placeholder="Ingresá tu PIN" autocomplete="current-password">' +
        '<div class="btns" style="margin-top:12px;margin-bottom:0"><button id="btnLogin" class="b-blue" style="width:100%">Desbloquear Panel</button></div>' +
        '</div></div>' +

        '<div id="viewMonitor">' +
        '<div class="grid" style="margin-bottom:0">' +
        '<div class="card"><div class="k">Reproduciendo</div><div class="v" id="now" style="font-size:13px;word-break:break-all">-</div><div class="pbarWrap"><div id="pbar" class="pbarFill"></div></div><div class="sub" id="ptime" style="margin-top:4px">-</div></div>' +
        '<div class="card"><div class="k">CPU / RAM / Temp</div><div class="v" id="hw">-</div><div class="sub" id="hwExtra" style="margin-top:4px">-</div></div>' +
        '<div class="card"><div class="k">Disco Libre / Pantalla</div><div class="v" id="disk">-</div><div class="sub" id="powerSub" style="margin-top:4px">-</div></div>' +
        '<div class="card"><div class="k">Video Wall</div><div class="v" id="vw" style="font-size:13px">-</div><div class="sub" id="uptimeSub" style="margin-top:4px">-</div></div>' +
        '</div>' +
        '<div class="btns">' +
        '<button id="btnTogglePause" class="b-ghost">Pausar / Reanudar</button>' +
        '<button id="btnNextItem" class="b-ghost">Siguiente ítem</button>' +
        '<button id="btnOpenWall" class="b-indigo">Configurar Video Wall</button>' +
        '<button id="btnRestartPlayer" class="b-amber">Reiniciar Reproductor</button>' +
        '<button id="btnUpdate" class="b-blue">Buscar OTA GitHub</button>' +
        '<button id="btnGc" class="b-green">Limpiar Huérfanos</button>' +
        '<button id="btnCleanLogs">Limpiar Logs</button>' +
        '<button id="btnReboot" class="b-amber">Reiniciar Pi</button>' +
        '<button id="btnShutdown" class="b-red">Apagar Pi</button>' +
        '<button id="btnDelete" class="b-red">Borrar Contenidos</button>' +
        '</div>' +
        '<div class="card"><div class="liveHead" style="margin-bottom:10px">' +
        '<div class="k" style="margin:0">Modo / Resolución de Conversión y Rotación de Pantalla</div>' +
        '<button type="button" id="btnSaveDisplay" class="b-green">Aplicar Pantalla / Conversión</button>' +
        '</div>' +
        '<div class="fgrid" style="margin-bottom:6px">' +
        '<div><label class="lbl" for="mResMode">Conversión de contenido (videos e imágenes)</label><select id="mResMode">' +
        '<option value="auto">Inteligente / Bajo CPU (Imágenes MP4 + H.264 hasta 1080p directo)</option>' +
        '<option value="720p">Forzar conversión todo a 1280x720 (Solo si suben 4K/pesados)</option>' +
        '<option value="1080p">Forzar conversión todo a 1920x1080 (Full HD 1080p)</option>' +
        '<option value="direct">Directo puro (Sin conversión ffmpeg)</option>' +
        '</select></div>' +
        '<div><label class="lbl" for="mOrient">Rotación de contenido / HDMI</label><select id="mOrient">' +
        '<option value="0">0° Horizontal Normal</option>' +
        '<option value="1">90° Vertical Derecha</option>' +
        '<option value="2">180° Invertido</option>' +
        '<option value="3">270° Vertical Izquierda</option>' +
        '</select></div>' +
        '<div><label class="lbl" for="mVoMode">Salida / Aceleración de Video</label><select id="mVoMode">' +
        '<option value="auto">Automática (Detecta EGL / X11 Ligero / DRM)</option>' +
        '<option value="x11_light">X11 Ligero sin OpenGL (Menor CPU en Pi 3B+)</option>' +
        '<option value="gpu_egl">GPU OpenGL ES / EGL (VideoCore)</option>' +
        '<option value="drm">DRM / KMS Directo (Sin escritorio X11)</option>' +
        '</select></div>' +
        '</div>' +
        '<label class="chkRow"><input type="checkbox" id="mHdmi720"> Ajustar salida HDMI/X11 a 1280x720 en Pi 3B+ o modo 720p (0% CPU, mejora fluidez)</label>' +
        '<label class="chkRow"><input type="checkbox" id="mStandby"> Mostrar pantalla de espera URP cuando aún no haya programación cargada</label>' +
        '</div>' +

        '<div class="fgrid" style="margin-bottom:0">' +
        '<div class="card"><div class="liveHead" style="margin-bottom:10px">' +
        '<div class="k" style="margin:0">Control de Audio y Volumen</div>' +
        '<button type="button" id="btnSaveAudio" class="b-blue">Aplicar Audio</button>' +
        '</div>' +
        '<div class="fgrid" style="margin-bottom:6px">' +
        '<div><label class="lbl" for="aVol">Volumen (<span id="aVolVal">100</span>%)</label><input type="range" id="aVol" min="0" max="100" step="5" value="100"></div>' +
        '<div><label class="lbl" for="aOut">Salida de Audio</label><select id="aOut">' +
        '<option value="auto">Automática del sistema</option>' +
        '<option value="hdmi">HDMI (TV)</option>' +
        '<option value="jack">Jack 3.5mm (Auriculares/Parlantes)</option>' +
        '</select></div>' +
        '</div>' +
        '<label class="chkRow"><input type="checkbox" id="aMuted"> Silenciar audio (Mute)</label>' +
        '</div>' +

        '<div class="card"><div class="liveHead" style="margin-bottom:10px">' +
        '<div class="k" style="margin:0">Ahorro de Energía (Horario HDMI)</div>' +
        '<button type="button" id="btnSavePower" class="b-indigo">Guardar Horario</button>' +
        '</div>' +
        '<div class="fgrid" style="margin-bottom:6px">' +
        '<div><label class="lbl" for="pOn">Encender HDMI</label><input type="time" id="pOn" value="08:00"></div>' +
        '<div><label class="lbl" for="pOff">Apagar HDMI</label><input type="time" id="pOff" value="22:00"></div>' +
        '</div>' +
        '<label class="chkRow" style="margin-bottom:8px"><input type="checkbox" id="pSchedEn"> Activar apagado/encendido automático de TV</label>' +
        '<div class="btns" style="margin:0"><button type="button" id="btnHdmiOn" class="b-green">Encender HDMI Ahora</button><button type="button" id="btnHdmiOff" class="b-amber">Apagar HDMI Ahora</button><button type="button" id="btnHdmiAuto" class="b-ghost">Modo Automático</button></div>' +
        '</div>' +
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

        '<div class="card"><div class="k">Agenda Cargada</div><div id="queues" class="sub" style="margin-top:4px">-</div><div id="agendaList" class="sub" style="margin-top:6px">Cargando agenda...</div></div>' +

        '<div class="card"><div class="liveHead" style="margin-bottom:8px">' +
        '<div class="k" style="margin:0">Logs en vivo</div>' +
        '<div class="btns" style="margin:0;align-items:center">' +
        '<input type="text" id="logFilter" placeholder="Filtrar logs (ej: ERR, OTA, PLAYER)" style="width:200px;padding:6px 9px;font-size:12px">' +
        '<label class="chkRow" style="padding:0;font-size:11px"><input type="checkbox" id="logFreeze"> Pausar scroll</label>' +
        '<button type="button" id="btnRefreshLogs" class="b-ghost" style="padding:6px 10px">Refrescar</button>' +
        '<button type="button" id="btnDownloadLogs" class="b-ghost" style="padding:6px 10px">Descargar .txt</button>' +
        '</div></div><pre id="logs">Cargando...</pre></div>' +

        '<div class="card"><div class="liveHead" style="margin-bottom:8px">' +
        '<div><div class="k" style="margin:0">Seguridad del Panel (:8090)</div><div class="sub" id="secState">Cargando estado de seguridad...</div></div>' +
        '</div>' +
        '<div id="secFormWrap" class="fgrid" style="margin-bottom:8px">' +
        '<div id="secCurWrap" class="hide"><label class="lbl" for="secCurPin">PIN actual</label><input type="password" id="secCurPin" placeholder="PIN actual"></div>' +
        '<div><label class="lbl" for="secNewPin">Nuevo PIN (mín. 4 caracteres)</label><input type="password" id="secNewPin" placeholder="Ej: 4829"></div>' +
        '</div>' +
        '<div id="secBtns" class="btns" style="margin:0"><button type="button" id="btnSavePin" class="b-blue">Guardar PIN</button><button type="button" id="btnClearPin" class="b-ghost hide">Quitar PIN</button></div>' +
        '</div>' +
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
        '<div><label class="lbl" for="wResMode">Conversión de Video / Imágenes</label><select id="wResMode">' +
        '<option value="auto">Inteligente / Bajo CPU (Imágenes MP4 + H.264 hasta 1080p directo)</option>' +
        '<option value="720p">Forzar conversión todo a 1280x720 (720p Fluido)</option>' +
        '<option value="1080p">Forzar conversión todo a 1920x1080 (Full HD 1080p)</option>' +
        '<option value="direct">Directo puro (En Mosaico recorta automático)</option>' +
        '</select></div>' +
        '</div>' +
        '<div class="fgrid">' +
        '<div><label class="lbl" for="wSync">Sincronización Video Wall</label><select id="wSync">' +
        '<option value="ntp">NTP automático (sin Master)</option>' +
        '<option value="master">Master LAN (esta Pi es reloj :8090)</option>' +
        '<option value="slave">Slave LAN (seguir IP de Master)</option>' +
        '</select></div>' +
        '<div id="wMasterWrap"><label class="lbl" for="wMasterIp">IP del Master LAN</label><input type="text" id="wMasterIp" placeholder="Ej: 192.168.1.50"></div>' +
        '</div>' +

        '<label class="chkRow"><input type="checkbox" id="wHdmi720"> Ajustar salida HDMI/X11 a 1280x720 cuando el modo esté en 720p (baja CPU y RAM)</label>' +
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
        'var authToken = "";' +
        'var isLocked = false;' +
        'var wallLoaded = false;' +
        'var displaySynced = false;' +
        'var audioPowerSynced = false;' +
        'var liveActive = false;' +
        'var liveTimer = null;' +
        'var liveInFlight = false;' +
        'var lastPreviewBlobUrl = "";' +
        'var rawLogsArr = [];' +
        'var nl = String.fromCharCode(10);' +
        'function byId(id){ return document.getElementById(id); }' +
        'function pad2(n){ n = parseInt(n, 10) || 0; return (n < 10 ? "0" : "") + n; }' +
        'function fmtUptime(sec){' +
        '  var s = Math.max(0, Math.floor(sec || 0));' +
        '  var d = Math.floor(s / 86400); s %= 86400;' +
        '  var h = Math.floor(s / 3600); s %= 3600;' +
        '  var m = Math.floor(s / 60);' +
        '  return (d > 0 ? (d + "d ") : "") + h + "h " + m + "m";' +
        '}' +
        'function setAuthLocked(locked){' +
        '  isLocked = Boolean(locked);' +
        '  if (isLocked) {' +
        '    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }' +
        '    byId("viewLogin").className = "";' +
        '    byId("viewMonitor").className = "hide";' +
        '    byId("viewWall").className = "hide";' +
        '  } else {' +
        '    byId("viewLogin").className = "hide";' +
        '    byId("viewMonitor").className = "";' +
        '  }' +
        '}' +
        'function authFetch(url, opts){' +
        '  opts = opts || {};' +
        '  var hdrs = Object.assign({}, opts.headers || {});' +
        '  if (authToken) hdrs["Authorization"] = "Bearer " + authToken;' +
        '  return fetch(url, Object.assign({}, opts, { headers: hdrs })).then(function(r){' +
        '    if (r.status === 401) {' +
        '      authToken = "";' +
        '      setAuthLocked(true);' +
        '    }' +
        '    return r;' +
        '  });' +
        '}' +
        'function syncDisplayQuickForm(cfg, effOrient){' +
        '  if (!cfg) return;' +
        '  byId("mResMode").value = (cfg.resolutionMode === "720p" || cfg.resolutionMode === "1080p" || cfg.resolutionMode === "direct") ? cfg.resolutionMode : "auto";' +
        '  var rotVal = (typeof effOrient === "number" && effOrient >= 0 && effOrient <= 3) ? effOrient : clampInt(cfg.orientation, 0, 3, 0);' +
        '  byId("mOrient").value = String(rotVal);' +
        '  byId("mVoMode").value = (cfg.videoOutputMode === "x11_light" || cfg.videoOutputMode === "gpu_egl" || cfg.videoOutputMode === "drm") ? cfg.videoOutputMode : (cfg.drmMode ? "drm" : "auto");' +
        '  byId("mHdmi720").checked = (cfg.hdmi720p !== false);' +
        '  byId("mStandby").checked = (cfg.showStandbyScreen !== false);' +
        '}' +
        'function syncAudioAndPowerForm(cfg){' +
        '  if (!cfg) return;' +
        '  var vol = (typeof cfg.audioVolume === "number") ? clampInt(cfg.audioVolume, 0, 100, 100) : 100;' +
        '  byId("aVol").value = vol;' +
        '  byId("aVolVal").textContent = String(vol);' +
        '  byId("aOut").value = (cfg.audioOutput === "hdmi" || cfg.audioOutput === "jack") ? cfg.audioOutput : "auto";' +
        '  byId("aMuted").checked = Boolean(cfg.audioMuted);' +
        '  byId("pOn").value = cfg.screenOnTime || "08:00";' +
        '  byId("pOff").value = cfg.screenOffTime || "22:00";' +
        '  byId("pSchedEn").checked = Boolean(cfg.screenScheduleEnabled);' +
        '}' +
        'function renderLogsBox(){' +
        '  var box = byId("logs");' +
        '  var q = String(byId("logFilter").value || "").trim().toLowerCase();' +
        '  var filtered = !q ? rawLogsArr : rawLogsArr.filter(function(ln){ return String(ln).toLowerCase().indexOf(q) !== -1; });' +
        '  box.textContent = filtered.join(nl) || "Sin logs coincidentes";' +
        '  if (!byId("logFreeze").checked) {' +
        '    box.scrollTop = box.scrollHeight;' +
        '  }' +
        '}' +
        'function renderAgenda(blocks){' +
        '  var box = byId("agendaList");' +
        '  if (!Array.isArray(blocks) || blocks.length === 0) {' +
        '    box.innerHTML = "";' +
        '    var emptyDiv = document.createElement("div");' +
        '    emptyDiv.style.padding = "8px 0";' +
        '    emptyDiv.textContent = "Sin bloques horarios cargados aún desde el Manager.";' +
        '    box.appendChild(emptyDiv);' +
        '    return;' +
        '  }' +
        '  box.innerHTML = "";' +
        '  for (var i = 0; i < blocks.length; i++) {' +
        '    var b = blocks[i];' +
        '    var blkDiv = document.createElement("div");' +
        '    blkDiv.className = "agendaBlk";' +
        '    var hd = document.createElement("div");' +
        '    hd.className = "agendaHead";' +
        '    var title = document.createElement("span");' +
        '    title.textContent = "Bloque #" + b.idScheduleBlock + " • Inicio " + pad2(b.startHour) + ":" + pad2(b.startMinute) + " (" + (b.items ? b.items.length : 0) + " items)";' +
        '    hd.appendChild(title);' +
        '    if (b.active) {' +
        '      var ab = document.createElement("span");' +
        '      ab.className = "tag on";' +
        '      ab.textContent = "ACTIVO AHORA";' +
        '      hd.appendChild(ab);' +
        '    }' +
        '    blkDiv.appendChild(hd);' +
        '    var items = b.items || [];' +
        '    for (var j = 0; j < items.length; j++) {' +
        '      var it = items[j];' +
        '      var row = document.createElement("div");' +
        '      row.className = "agendaRow";' +
        '      var left = document.createElement("span");' +
        '      left.style.wordBreak = "break-all";' +
        '      left.textContent = (j + 1) + ". " + (it.name || it.content || "-") + (it.name && it.content && it.name !== it.content ? (" (" + it.content + ")") : "");' +
        '      var right = document.createElement("span");' +
        '      right.style.display = "flex";' +
        '      right.style.gap = "6px";' +
        '      right.style.alignItems = "center";' +
        '      var metaTag = document.createElement("span");' +
        '      metaTag.className = "tag";' +
        '      metaTag.textContent = (it.kind || "Media") + " • " + (it.duration || 10) + "s";' +
        '      var stTag = document.createElement("span");' +
        '      stTag.className = "tag " + (it.ready ? "on" : "wait");' +
        '      stTag.textContent = it.ready ? "Listo" : "Pendiente";' +
        '      right.appendChild(metaTag);' +
        '      right.appendChild(stTag);' +
        '      row.appendChild(left);' +
        '      row.appendChild(right);' +
        '      blkDiv.appendChild(row);' +
        '    }' +
        '    box.appendChild(blkDiv);' +
        '  }' +
        '}' +
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
        '  if (!liveActive || isLocked) return;' +
        '  if (liveTimer) clearTimeout(liveTimer);' +
        '  var ms = clampInt(byId("liveInt").value, 1000, 30000, 3000);' +
        '  liveTimer = setTimeout(fetchLiveFrame, ms);' +
        '}' +
        'function fetchLiveFrame(){' +
        '  if (liveInFlight || isLocked) return;' +
        '  liveInFlight = true;' +
        '  var img = byId("shotImg");' +
        '  authFetch("/api/preview.jpg?t=" + Date.now()).then(function(r){' +
        '    if (!r.ok) throw new Error("no frame");' +
        '    return r.blob();' +
        '  }).then(function(blob){' +
        '    liveInFlight = false;' +
        '    if (lastPreviewBlobUrl) { try { URL.revokeObjectURL(lastPreviewBlobUrl); } catch (e) {} }' +
        '    lastPreviewBlobUrl = URL.createObjectURL(blob);' +
        '    byId("liveEmpty").style.display = "none";' +
        '    img.style.display = "block";' +
        '    img.src = lastPreviewBlobUrl;' +
        '    byId("liveMeta").textContent = "Último frame capturado: " + new Date().toLocaleTimeString();' +
        '    scheduleLiveNext();' +
        '  }).catch(function(){' +
        '    liveInFlight = false;' +
        '    byId("liveMeta").textContent = "Sin frame disponible aún (esperando reproductor...)";' +
        '    scheduleLiveNext();' +
        '  });' +
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
        '  byId("wResMode").value = (cfg.resolutionMode === "720p" || cfg.resolutionMode === "1080p" || cfg.resolutionMode === "direct") ? cfg.resolutionMode : "auto";' +
        '  byId("wHdmi720").checked = (cfg.hdmi720p !== false);' +
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
        '  if (isLocked) return;' +
        '  authFetch("/api/status").then(function(r){' +
        '    if (r.status === 401) return null;' +
        '    return r.json();' +
        '  }).then(function(s){' +
        '    if (!s) return;' +
        '    lastStatus = s;' +
        '    var displayTitle = s.managerName || s.hostname || "URP Signage Monitor";' +
        '    byId("titleMain").textContent = displayTitle;' +
        '    document.title = displayTitle + " • v" + s.version;' +
        '    byId("ver").textContent = "v" + s.version;' +
        '    byId("meta").textContent = (s.model || "Linux") + " • Host " + (s.hostname || "-") + " • IP " + (s.ip || "-") + (s.tailscaleIp ? (" • Tailscale " + s.tailscaleIp) : "") + " • " + s.displayBackend + (s.targetResolution ? (" • " + s.targetResolution) : "") + (s.playerDriver ? (" • " + s.playerDriver) : "");' +
        '    byId("conn").textContent = s.connection ? "tbee.tv ONLINE" : "MODO OFFLINE";' +
        '    var alertEl = byId("hwAlert");' +
        '    if (s.throttleStatus && !s.throttleStatus.ok) {' +
        '      alertEl.textContent = "Alerta de Hardware Raspberry Pi: " + s.throttleStatus.label + " (revisá fuente 5V 2.5A/3A o disipación).";' +
        '      alertEl.style.display = "flex";' +
        '    } else if (typeof s.freeDiskMb === "number" && s.freeDiskMb >= 0 && s.freeDiskMb < 600) {' +
        '      alertEl.textContent = "Alerta de Disco: quedan solo " + s.freeDiskMb + " MB libres en microSD.";' +
        '      alertEl.style.display = "flex";' +
        '    } else {' +
        '      alertEl.style.display = "none";' +
        '    }' +
        '    var pl = s.player || {};' +
        '    var playingLabel = (pl.file || s.filesPlaying.join(", ") || "En espera");' +
        '    byId("now").textContent = (pl.paused ? "[PAUSA] " : "") + playingLabel;' +
        '    byId("btnTogglePause").textContent = pl.paused ? "Reanudar" : "Pausar / Reanudar";' +
        '    if (pl.duration && pl.duration > 0) {' +
        '      var pct = Math.max(0, Math.min(100, Math.round((pl.timePos / pl.duration) * 100)));' +
        '      byId("pbar").style.width = pct + "%";' +
        '      byId("ptime").textContent = fmtSec(pl.timePos) + " / " + fmtSec(pl.duration) + " (" + pct + "%) • " + (s.playerDriver || pl.bin || "mpv");' +
        '    } else {' +
        '      byId("pbar").style.width = "0%";' +
        '      byId("ptime").textContent = pl.active ? ("Motor: " + (s.playerDriver || pl.bin || "-")) : (s.screenPoweredOff ? "Pantalla apagada por ahorro de energía" : "Sin reproducción activa");' +
        '    }' +
        '    byId("hw").textContent = s.cpuUsage + "% / " + s.memPercentUsed + "% / " + s.temperature + "°C";' +
        '    byId("hwExtra").textContent = "Energía: " + ((s.throttleStatus && s.throttleStatus.label) ? s.throttleStatus.label : "OK");' +
        '    byId("disk").textContent = s.freeSpace;' +
        '    byId("powerSub").textContent = "HDMI: " + (s.screenPoweredOff ? "APAGADA" : "ENCENDIDA") + " • Audio: " + (s.wallConfig && s.wallConfig.audioMuted ? "MUTE" : ((s.wallConfig ? s.wallConfig.audioVolume : 100) + "%"));' +
        '    byId("vw").textContent = s.wallActive ? (s.wallConfig.mode + " " + s.wallConfig.rows + "x" + s.wallConfig.cols + " #" + s.wallConfig.screenId + " (drift " + (s.wallSyncStatus.driftMs || 0) + "ms)") : ("Normal (" + (s.wallConfig.activationMode === "server" ? "remoto tbee.tv OFF" : "desactivado") + ")");' +
        '    byId("uptimeSub").textContent = "Uptime Pi: " + fmtUptime(s.osUptimeSec) + " • Proceso: " + fmtUptime(s.uptimeSec);' +
        '    byId("queues").textContent = "Bloque activo: " + s.blockPlaying + " | Bloques hoy: " + s.scheduleCount + " | Descargas FTP: " + s.queues.ftp + " | Imágenes: " + s.queues.render + " | Videos Opt: " + s.queues.videoOpt + " | Seamless activo: " + (s.queues.concatenating ? "Sí" : "No");' +
        '    renderAgenda(s.scheduleSummary || []);' +
        '    rawLogsArr = Array.isArray(s.logs) ? s.logs : [];' +
        '    renderLogsBox();' +
        '    var sec = s.security || {};' +
        '    byId("btnLogout").className = sec.pinEnabled ? "b-ghost" : "b-ghost hide";' +
        '    if (sec.envManaged) {' +
        '      byId("secState").textContent = "PIN administrado por variable de entorno URP_PANEL_PIN en el servidor.";' +
        '      byId("secFormWrap").className = "hide";' +
        '      byId("secBtns").className = "hide";' +
        '    } else {' +
        '      byId("secFormWrap").className = "fgrid";' +
        '      byId("secBtns").className = "btns";' +
        '      byId("secState").textContent = sec.pinEnabled ? "Panel protegido con PIN (sesión en memoria)." : "Sin PIN configurado (acceso abierto en LAN/Tailscale).";' +
        '      byId("secCurWrap").className = sec.pinEnabled ? "" : "hide";' +
        '      byId("btnClearPin").className = sec.pinEnabled ? "b-ghost" : "b-ghost hide";' +
        '    }' +
        '    if (!wallLoaded && s.wallConfig) { syncToForm(s.wallConfig, s.serverVideoWallFlag); wallLoaded = true; }' +
        '    if (!displaySynced && s.wallConfig) { syncDisplayQuickForm(s.wallConfig, s.effectiveOrientation); displaySynced = true; }' +
        '    if (!audioPowerSynced && s.wallConfig) { syncAudioAndPowerForm(s.wallConfig); audioPowerSynced = true; }' +
        '  }).catch(function(){});' +
        '}' +
        'function postJson(url, payload, onOk){' +
        '  authFetch(url, {' +
        '    method: "POST",' +
        '    headers: { "Content-Type": "application/json" },' +
        '    body: JSON.stringify(payload || {})' +
        '  }).then(function(r){ return r.json(); }).then(function(res){' +
        '    if (!res || !res.ok) { showMsg((res && res.error) ? res.error : "Error ejecutando acción", "err"); return; }' +
        '    if (typeof onOk === "function") onOk(res);' +
        '    refresh();' +
        '  }).catch(function(e){ showMsg("Error: " + e.message, "err"); });' +
        '}' +
        'function saveDisplaySettings(){' +
        '  var payload = {' +
        '    resolutionMode: byId("mResMode").value,' +
        '    orientation: clampInt(byId("mOrient").value, 0, 3, 0),' +
        '    videoOutputMode: byId("mVoMode").value,' +
        '    hdmi720p: Boolean(byId("mHdmi720").checked),' +
        '    showStandbyScreen: Boolean(byId("mStandby").checked)' +
        '  };' +
        '  postJson("/api/display-settings", payload, function(res){' +
        '    displaySynced = false;' +
        '    wallLoaded = false;' +
        '    var info = "Configuración aplicada: " + (res.targetResolution || payload.resolutionMode) + ", rotación " + (payload.orientation * 90) + "°, salida " + (payload.videoOutputMode || "auto") + ".";' +
        '    if (res.rotChanged) info += res.rotUpdated ? " (config.txt actualizado; rotación aplicada al reproductor)" : " (rotación aplicada en caliente por X11/mpv)";' +
        '    showMsg(info, "ok");' +
        '  });' +
        '}' +
        'function act(u){' +
        '  authFetch(u).then(function(r){ return r.text(); }).then(function(t){' +
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
        '    drmMode: Boolean(byId("wDrm").checked),' +
        '    resolutionMode: byId("wResMode").value,' +
        '    hdmi720p: Boolean(byId("wHdmi720").checked)' +
        '  };' +
        '  postJson("/api/wall", payload, function(res){' +
        '    wallLoaded = false;' +
        '    closeWallView();' +
        '    var info = "Video Wall guardado (" + res.config.mode + " " + res.config.rows + "x" + res.config.cols + " #" + res.config.screenId + ").";' +
        '    if (res.rotChanged) info += res.rotUpdated ? " HDMI rotate actualizado en config.txt (reiniciá la Pi para rotación física completa)." : " Aviso: rotación HDMI requiere sudo desde SSH (urp-wall).";' +
        '    showMsg(info, "ok");' +
        '  });' +
        '}' +
        'byId("btnLogin").onclick = function(){' +
        '  var pin = byId("loginPin").value;' +
        '  fetch("/api/auth/login", {' +
        '    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: pin })' +
        '  }).then(function(r){ return r.json(); }).then(function(res){' +
        '    if (!res || !res.ok || !res.token) { showMsg((res && res.error) ? res.error : "PIN incorrecto", "err"); return; }' +
        '    authToken = res.token;' +
        '    byId("loginPin").value = "";' +
        '    showMsg("");' +
        '    setAuthLocked(false);' +
        '    refresh();' +
        '  }).catch(function(e){ showMsg("Error de acceso: " + e.message, "err"); });' +
        '};' +
        'byId("loginPin").onkeydown = function(ev){ if (ev.key === "Enter") byId("btnLogin").click(); };' +
        'byId("btnLogout").onclick = function(){' +
        '  authFetch("/api/auth/logout", { method: "POST" }).catch(function(){});' +
        '  authToken = "";' +
        '  setAuthLocked(true);' +
        '};' +
        'byId("btnSaveAudio").onclick = function(){' +
        '  postJson("/api/audio", {' +
        '    volume: clampInt(byId("aVol").value, 0, 100, 100),' +
        '    muted: Boolean(byId("aMuted").checked),' +
        '    output: byId("aOut").value' +
        '  }, function(){ audioPowerSynced = false; showMsg("Audio actualizado correctamente.", "ok"); });' +
        '};' +
        'byId("aVol").oninput = function(){ byId("aVolVal").textContent = this.value; };' +
        'byId("btnSavePower").onclick = function(){' +
        '  postJson("/api/power-schedule", {' +
        '    enabled: Boolean(byId("pSchedEn").checked),' +
        '    onTime: byId("pOn").value,' +
        '    offTime: byId("pOff").value,' +
        '    manualAction: "auto"' +
        '  }, function(){ audioPowerSynced = false; showMsg("Horario de energía HDMI guardado.", "ok"); });' +
        '};' +
        'byId("btnHdmiOn").onclick = function(){ postJson("/api/power-schedule", { manualAction: "on" }, function(){ showMsg("HDMI encendido manualmente.", "ok"); }); };' +
        'byId("btnHdmiOff").onclick = function(){ postJson("/api/power-schedule", { manualAction: "off" }, function(){ showMsg("HDMI apagado manualmente.", "ok"); }); };' +
        'byId("btnHdmiAuto").onclick = function(){ postJson("/api/power-schedule", { manualAction: "auto" }, function(){ showMsg("Control HDMI devuelto a modo automático.", "ok"); }); };' +
        'byId("btnSavePin").onclick = function(){' +
        '  postJson("/api/security/pin", { currentPin: byId("secCurPin").value, newPin: byId("secNewPin").value }, function(res){' +
        '    if (res.token) authToken = res.token;' +
        '    byId("secCurPin").value = ""; byId("secNewPin").value = "";' +
        '    showMsg("PIN de seguridad actualizado.", "ok");' +
        '  });' +
        '};' +
        'byId("btnClearPin").onclick = function(){' +
        '  postJson("/api/security/pin", { currentPin: byId("secCurPin").value, newPin: "" }, function(){' +
        '    authToken = ""; byId("secCurPin").value = ""; byId("secNewPin").value = "";' +
        '    showMsg("PIN desactivado (panel abierto en LAN/Tailscale).", "ok");' +
        '  });' +
        '};' +
        'byId("btnTogglePause").onclick = function(){ postJson("/api/player/toggle-pause", {}, function(res){ showMsg(res.paused ? "Reproducción en pausa." : "Reproducción reanudada.", "ok"); }); };' +
        'byId("btnNextItem").onclick = function(){ postJson("/api/player/next", {}, function(){ showMsg("Avanzando al siguiente contenido.", "ok"); }); };' +
        'byId("logFilter").oninput = renderLogsBox;' +
        'byId("btnRefreshLogs").onclick = function(){' +
        '  authFetch("/api/logs").then(function(r){ return r.json(); }).then(function(d){' +
        '    if (d && Array.isArray(d.logs)) { rawLogsArr = d.logs; renderLogsBox(); }' +
        '  }).catch(function(){});' +
        '};' +
        'byId("btnDownloadLogs").onclick = function(){' +
        '  var blob = new Blob([rawLogsArr.join(nl)], { type: "text/plain" });' +
        '  var url = URL.createObjectURL(blob);' +
        '  var a = document.createElement("a"); a.href = url; a.download = "urp-logs.txt";' +
        '  document.body.appendChild(a); a.click(); document.body.removeChild(a);' +
        '  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);' +
        '};' +
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
        'byId("btnSaveDisplay").onclick = saveDisplaySettings;' +
        'byId("btnUpdate").onclick = function(){ act("/update"); };' +
        'byId("btnGc").onclick = function(){ act("/gc"); };' +
        'byId("btnCleanLogs").onclick = function(){ act("/cleanLogs"); };' +
        'byId("btnShot").onclick = function(){ fetchLiveFrame(); };' +
        'byId("btnReboot").onclick = function(){ if (confirm("¿Reiniciar Raspberry Pi?")) act("/reboot"); };' +
        'byId("btnShutdown").onclick = function(){ if (confirm("¿Apagar Raspberry Pi?")) act("/shutdown"); };' +
        'byId("btnDelete").onclick = function(){ if (confirm("¿Borrar todo el contenido local?")) act("/deleteContents"); };' +
        'fetch("/api/auth/check").then(function(r){ return r.json(); }).then(function(a){' +
        '  if (a && a.locked) { setAuthLocked(true); } else { setAuthLocked(false); refresh(); }' +
        '}).catch(function(){ refresh(); });' +
        'setInterval(refresh, 3000);' +
        '</script></body></html>';
}

var express = require('express');
var app = express();
app.use(express.static(__dirname + '/web'));

app.use(function (req, res, next) {
    var origin = req.headers.origin;
    if (origin && !getPanelAuthConfig().enabled) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.get('/', function (req, res) {
    res.status(200).type('html').send(buildLocalDashboardHtml());
});

app.get('/api/auth/check', function (req, res) {
    loadWallConfig();
    var cfg = getPanelAuthConfig();
    var authed = isRequestAuthenticated(req);
    res.json({
        pinEnabled: cfg.enabled,
        envManaged: cfg.envManaged,
        locked: cfg.enabled && !authed
    });
});

app.post('/api/auth/login', function (req, res) {
    readJsonBody(req, function (err, body) {
        if (err || !body || typeof body !== 'object') {
            return res.status(400).json({ ok: false, error: 'JSON inválido' });
        }
        loadWallConfig();
        var clientKey = String((req.socket && req.socket.remoteAddress) || 'local');
        var failRec = authFailures[clientKey];
        if (failRec && failRec.until > Date.now()) {
            return res.status(429).json({ ok: false, error: 'Demasiados intentos; esperá 60 segundos.' });
        }
        if (!getPanelAuthConfig().enabled) {
            return res.json({ ok: true, token: issueAuthToken() });
        }
        if (!verifyPanelPin(body.pin)) {
            var count = (failRec && failRec.resetAt > Date.now()) ? (failRec.count + 1) : 1;
            authFailures[clientKey] = {
                count: count,
                resetAt: Date.now() + 60000,
                until: (count >= 5) ? (Date.now() + 60000) : 0
            };
            return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
        }
        delete authFailures[clientKey];
        res.json({ ok: true, token: issueAuthToken() });
    });
});

app.post('/api/auth/logout', function (req, res) {
    var authHdr = String((req.headers && req.headers.authorization) || '');
    if (authHdr.indexOf('Bearer ') === 0) {
        delete authSessions[authHdr.slice(7).trim()];
    }
    res.json({ ok: true });
});

app.post('/api/security/pin', requirePanelAuth, function (req, res) {
    readJsonBody(req, function (err, body) {
        if (err || !body || typeof body !== 'object') {
            return res.status(400).json({ ok: false, error: 'JSON inválido' });
        }
        loadWallConfig();
        var authCfg = getPanelAuthConfig();
        if (authCfg.envManaged) {
            return res.status(403).json({ ok: false, error: 'El PIN está fijado por variable de entorno URP_PANEL_PIN' });
        }
        if (authCfg.enabled && !verifyPanelPin(body.currentPin)) {
            return res.status(401).json({ ok: false, error: 'PIN actual incorrecto' });
        }
        var newPin = String(body.newPin || '').trim();
        if (!newPin) {
            saveWallConfigPartial({ panelPinHash: '' });
            authSessions = {};
            console.log('[SECURITY] PIN del panel :8090 desactivado.');
            return res.json({ ok: true, pinEnabled: false });
        }
        if (newPin.length < 4 || newPin.length > 32) {
            return res.status(400).json({ ok: false, error: 'El PIN debe tener entre 4 y 32 caracteres.' });
        }
        saveWallConfigPartial({ panelPinHash: hashPinScrypt(newPin) });
        authSessions = {};
        var freshToken = issueAuthToken();
        console.log('[SECURITY] PIN del panel :8090 actualizado (scrypt).');
        res.json({ ok: true, pinEnabled: true, token: freshToken });
    });
});

function buildScheduleSummaryForStatus() {
    var arr = Array.isArray(schedule) ? schedule : [];
    if (arr.length === 0 && typeof schedule === 'object' && schedule !== null) {
        arr = Object.keys(schedule).map(function (k) { return schedule[k]; });
    }
    var dimsNow = getTargetVideoDims();
    var resTag = dimsNow.use720p ? '_720p' : '';
    var wallTag = isWallTileActive() ? ('_' + getWallSignature()) : '';
    return arr.map(function (blk) {
        var bItems = Array.isArray(blk.contents) ? blk.contents : [];
        return {
            idScheduleBlock: blk.idScheduleBlock,
            startHour: blk.startHour,
            startMinute: blk.startMinute,
            active: String(blk.idScheduleBlock) === String(blockPlaying),
            items: bItems.map(function (it) {
                var rawC = String(it.content || '');
                var safeC = normalizeName(rawC);
                var dur = parseInt(it.length, 10) || 10;
                var imgItem = isImg(safeC) || isImg(rawC);
                var ready = false;
                if (imgItem) {
                    var imgMp4 = contentBasePath + safeC.replace(/\.[^/.]+$/, '') + resTag + wallTag + '_' + dur + 's.mp4';
                    ready = dimsNow.convertEnabled
                        ? ((fileExist(imgMp4) && fs.statSync(imgMp4).size > 4096) || fileExist(contentBasePath + safeC) || fileExist(contentBasePath + rawC))
                        : Boolean(fileExist(contentBasePath + safeC) || fileExist(contentBasePath + rawC));
                } else if (safeC) {
                    var rawPath = fileExist(contentBasePath + safeC) ? (contentBasePath + safeC) : (contentBasePath + rawC);
                    var optP = dimsNow.convertEnabled ? getOptimizedVideoPath(rawPath) : null;
                    ready = Boolean((optP && fileExist(optP)) || fileExist(rawPath));
                }
                return {
                    idContent: it.idContent || 0,
                    name: String(it.name || safeC || rawC),
                    content: rawC,
                    duration: dur,
                    kind: imgItem ? 'Imagen' : 'Video',
                    ready: Boolean(ready)
                };
            })
        };
    });
}

app.get('/api/status', requirePanelAuth, function (req, res) {
    loadWallConfig();
    var buildPayload = function (pl) {
        var dimsNow = getTargetVideoDims();
        var effOrient = readHdmiRotateFromConfig();
        var secCfg = getPanelAuthConfig();
        res.json({
            version: URPVersion,
            model: piModelStr,
            hostname: osMod.hostname(),
            managerName: URPdata.managerName || '',
            totalRamMB: totalRamMB,
            displayBackend: useDrmDirect ? 'DRM/KMS' : (hasWaylandDisplay ? 'Wayland' : 'X11'),
            playerDriver: activeMpvDriverInfo || (hasOmxplayer ? 'omxplayer' : 'mpv'),
            glRenderer: mpvCaps.glRenderer || '',
            targetResolution: !dimsNow.convertEnabled ? ('Directo' + (dimsNow.use720p && wallConfig.hdmi720p !== false ? ' • HDMI 720p' : ' (Original)')) : (dimsNow.mode === 'auto' ? ('Inteligente' + (dimsNow.use720p ? ' (720p img / H.264 directo)' : ' (1080p)')) : (dimsNow.width + 'x' + dimsNow.height + (dimsNow.use720p ? ' (720p Forzado)' : ' (1080p)'))),
            effectiveOrientation: (effOrient !== null) ? effOrient : (wallConfig.orientation || 0),
            ip: URPdata.URPIpAddress || '',
            tailscaleIp: getTailscaleIp(),
            mac: macAdd,
            uptimeSec: Math.round(process.uptime()),
            osUptimeSec: Math.round(osMod.uptime()),
            connection: iConn,
            freeSpace: URPFreeSpace,
            freeDiskMb: freeDiskMb,
            temperature: temperature,
            cpuUsage: cpuUsage,
            memPercentUsed: memPercentUsed,
            throttleStatus: throttleStatus,
            screenPoweredOff: isScreenPoweredOff,
            security: { pinEnabled: secCfg.enabled, envManaged: secCfg.envManaged },
            blockPlaying: blockPlaying,
            nowPlayingId: URPNowPlaying,
            filesPlaying: filesPlaying,
            player: pl,
            scheduleCount: Array.isArray(schedule) ? schedule.length : 0,
            scheduleSummary: buildScheduleSummaryForStatus(),
            serverVideoWallFlag: Boolean(URPdata && URPdata.isVideoWall),
            wallActive: isWallActive(),
            wallConfig: getWallConfigPublic(),
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

app.get('/api/logs', requirePanelAuth, function (req, res) {
    res.json({ ok: true, logs: recentLogs });
});

app.get('/api/preview.jpg', requirePanelAuth, function (req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    captureLivePreview(function (ok, previewPath) {
        if (ok && fs.existsSync(previewPath)) {
            return res.sendFile(previewPath);
        }
        res.status(404).send('Sin captura disponible');
    });
});

app.post('/api/player/toggle-pause', requirePanelAuth, function (req, res) {
    if (!isPlaying || !activePlayerProcess || activePlayerBin !== 'mpv' || !fs.existsSync(mpvIpcSocketPath)) {
        return res.status(409).json({ ok: false, error: 'Pausa rápida disponible cuando mpv está reproduciendo.' });
    }
    mpvIpcRequest([['cycle', 'pause'], ['get_property', 'pause']], function (err, ipcRes) {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        var paused = Boolean(ipcRes && ipcRes[2] && ipcRes[2].error === 'success' && ipcRes[2].data);
        res.json({ ok: true, paused: paused });
    });
});

app.post('/api/player/next', requirePanelAuth, function (req, res) {
    if (!isPlaying || currentPlaylist.length === 0) {
        return res.status(409).json({ ok: false, error: 'Sin playlist activa.' });
    }
    if (activePlayerProcess && activePlayerBin === 'mpv' && currentPlaylist.length > 1 && fs.existsSync(mpvIpcSocketPath)) {
        mpvIpcRequest([['playlist-next', 'force']], function (err) {
            if (!err) return res.json({ ok: true, method: 'ipc' });
            currentMediaIndex++;
            playCurrentIndex();
            res.json({ ok: true, method: 'restart' });
        });
        return;
    }
    currentMediaIndex++;
    playCurrentIndex();
    res.json({ ok: true, method: 'index' });
});

app.post('/api/audio', requirePanelAuth, function (req, res) {
    readJsonBody(req, function (err, body) {
        if (err || !body || typeof body !== 'object') {
            return res.status(400).json({ ok: false, error: 'JSON inválido' });
        }
        loadWallConfig();
        var vol = (body.volume !== undefined) ? Math.max(0, Math.min(100, parseInt(body.volume, 10) || 0)) : wallConfig.audioVolume;
        var muted = (body.muted !== undefined) ? Boolean(body.muted) : wallConfig.audioMuted;
        var out = (body.output === 'hdmi' || body.output === 'jack' || body.output === 'auto') ? body.output : wallConfig.audioOutput;
        saveWallConfigPartial({ audioVolume: vol, audioMuted: muted, audioOutput: out });
        applyAudioSettings(function () {
            res.json({ ok: true, config: getWallConfigPublic() });
        });
    });
});

app.post('/api/power-schedule', requirePanelAuth, function (req, res) {
    readJsonBody(req, function (err, body) {
        if (err || !body || typeof body !== 'object') {
            return res.status(400).json({ ok: false, error: 'JSON inválido' });
        }
        loadWallConfig();
        var patch = {};
        if (body.enabled !== undefined) patch.screenScheduleEnabled = Boolean(body.enabled);
        if (body.onTime !== undefined) patch.screenOnTime = sanitizeTimeHHMM(body.onTime, wallConfig.screenOnTime);
        if (body.offTime !== undefined) patch.screenOffTime = sanitizeTimeHHMM(body.offTime, wallConfig.screenOffTime);
        if (Object.keys(patch).length > 0) {
            saveWallConfigPartial(patch);
        }
        if (body.manualAction === 'on') {
            manualScreenOffOverride = false;
            return applyScreenPowerState(true, function () {
                res.json({ ok: true, screenPoweredOff: isScreenPoweredOff, config: getWallConfigPublic() });
            });
        }
        if (body.manualAction === 'off') {
            manualScreenOffOverride = true;
            return applyScreenPowerState(false, function () {
                res.json({ ok: true, screenPoweredOff: isScreenPoweredOff, config: getWallConfigPublic() });
            });
        }
        manualScreenOffOverride = null;
        syncScreenPowerSchedule();
        res.json({ ok: true, screenPoweredOff: isScreenPoweredOff, config: getWallConfigPublic() });
    });
});

app.get('/restartPlayer', requirePanelAuth, function (req, res) {
    blockPlaying = 0;
    stopOmx(function () {
        setTimeout(function () { checkSchedule(); }, 250);
    });
    res.status(200).send('Reproductor reiniciado');
});

app.get('/resetContent', requirePanelAuth, function (req, res) {
    blockPlaying = 0;
    checkSchedule();
    res.status(200).send('Reset Content');
});
app.get('/reboot', requirePanelAuth, function (req, res) {
    res.status(200).send('Reboot');
    setTimeout(resetURP, 200);
});
app.get('/shutdown', requirePanelAuth, function (req, res) {
    res.status(200).send('Shutdown');
    setTimeout(shutdownURP, 200);
});
app.get('/deleteContents', requirePanelAuth, function (req, res) {
    res.status(200).send('Delete Contents');
    deleteContentFiles();
});
app.get('/deleteContent', requirePanelAuth, function (req, res) {
    res.status(200).send('Delete Contents');
    deleteContentFiles();
});
app.get('/gc', requirePanelAuth, function (req, res) {
    garbageCollectUnusedMedia(false, function (info) {
        res.json(info);
    });
});
app.get('/cleanLogs', requirePanelAuth, function (req, res) {
    cleanLogs();
    res.status(200).send('Clean Logs');
});
app.get('/uploadLogs', requirePanelAuth, function (req, res) {
    uploadLogs(function (ok) {
        res.status(200).send(ok ? 'Logs uploaded' : 'No logs');
    });
});
app.get('/screenshot', requirePanelAuth, function (req, res) {
    takeScreenshot(function (ok) {
        res.status(ok ? 200 : 500).send(ok ? 'Screenshot OK' : 'Screenshot failed');
    });
});
app.get('/screenshot.jpg', requirePanelAuth, function (req, res) {
    var p = basePath + 'screenshot.jpg';
    if (fs.existsSync(p)) return res.sendFile(p);
    res.status(404).send('No screenshot');
});
app.get('/contents', requirePanelAuth, function (req, res) {
    try {
        var files = fs.readdirSync(contentBasePath);
        res.json({ contents: files.map(function (f) { return { file: f }; }) });
    } catch (e) {
        res.json({ contents: [] });
    }
});
app.get('/schedule', requirePanelAuth, function (req, res) {
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
app.get('/update', requirePanelAuth, function (req, res) {
    checkGithubOTA(function (result) { res.json(result); });
});
app.get('/wall', requirePanelAuth, function (req, res) {
    loadWallConfig();
    res.json({
        active: isWallActive(),
        tileActive: isWallTileActive(),
        activationMode: wallConfig.activationMode,
        serverVideoWallFlag: Boolean(URPdata && URPdata.isVideoWall),
        signature: getWallSignature(),
        config: getWallConfigPublic(),
        syncStatus: wallSyncStatus,
        masterState: wallMasterState
    });
});
app.post('/api/display-settings', requirePanelAuth, function (req, res) {
    readJsonBody(req, function (err, body) {
        if (err || !body || typeof body !== 'object') {
            return res.status(400).json({ ok: false, error: 'JSON inválido' });
        }
        try {
            loadWallConfig();
            var dimsBefore = getTargetVideoDims();
            var prevRot = wallConfig.orientation;
            var prevResMode = wallConfig.resolutionMode;
            var prevOrient = wallConfig.orientation;
            var prevVoMode = wallConfig.videoOutputMode || 'auto';
            var orientation = [0, 1, 2, 3].indexOf(parseInt(body.orientation, 10)) !== -1 ? parseInt(body.orientation, 10) : wallConfig.orientation;
            var resMode = (body.resolutionMode === 'auto' || body.resolutionMode === '720p' || body.resolutionMode === '1080p' || body.resolutionMode === 'direct') ? body.resolutionMode : wallConfig.resolutionMode;
            var voMode = (body.videoOutputMode === 'x11_light' || body.videoOutputMode === 'gpu_egl' || body.videoOutputMode === 'drm' || body.videoOutputMode === 'auto') ? body.videoOutputMode : prevVoMode;
            var hdmi720p = (body.hdmi720p === undefined) ? wallConfig.hdmi720p : Boolean(body.hdmi720p);
            var showStandby = (body.showStandbyScreen === undefined) ? wallConfig.showStandbyScreen : Boolean(body.showStandbyScreen);
            var rotChanged = (orientation !== prevRot);
            var rotUpdated = false;
            if (rotChanged) {
                var rotRes = writeHdmiRotateToConfig(orientation);
                rotUpdated = Boolean(rotRes && rotRes.ok);
            }
            saveWallConfigPartial({
                orientation: orientation,
                resolutionMode: resMode,
                hdmi720p: hdmi720p,
                showStandbyScreen: showStandby,
                videoOutputMode: voMode,
                drmMode: (voMode === 'drm'),
                orientationOverride: rotChanged ? (!rotUpdated) : Boolean(wallConfig.orientationOverride)
            });
            mpvSafeFallback = false;
            if (voMode === 'drm' && (hasX11Display || hasWaylandDisplay)) {
                exec('sudo -n systemctl stop lightdm 2>/dev/null || sudo -n systemctl stop gdm 2>/dev/null || true', { timeout: 3000 }, function () {
                    detectDisplaySession();
                });
            }
            lastAppliedHdmiRes = '';
            applyDisplayResolution720pIfNeeded(true);
            applyDisplayRotationIfNeeded(null, true);

            if (resMode === 'direct' && !isWallTileActive()) {
                renderQueue = [];
                videoOptQueue = [];
            }
            var dimsNow = getTargetVideoDims();
            if ((dimsBefore.convertEnabled || dimsNow.convertEnabled) && (resMode !== prevResMode || (rotChanged && (prevOrient % 2 !== orientation % 2)))) {
                clearWallDerivedCaches();
            }
            blockPlaying = 0;
            stopOmx(function () {
                setTimeout(function () { checkSchedule(); }, 250);
            });

            res.json({
                ok: true,
                config: getWallConfigPublic(),
                targetResolution: !dimsNow.convertEnabled ? ('Directo' + (dimsNow.use720p && wallConfig.hdmi720p !== false ? ' • HDMI 720p' : ' (Original)')) : (dimsNow.mode === 'auto' ? ('Inteligente' + (dimsNow.use720p ? ' (720p img / H.264 directo)' : ' (1080p)')) : (dimsNow.width + 'x' + dimsNow.height + (dimsNow.use720p ? ' (720p Forzado)' : ' (1080p)'))),
                rotChanged: rotChanged,
                rotUpdated: rotUpdated
            });
        } catch (saveErr) {
            res.status(500).json({ ok: false, error: saveErr.message });
        }
    });
});

app.post('/api/wall', requirePanelAuth, function (req, res) {
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
            var resMode = (body.resolutionMode === '720p' || body.resolutionMode === '1080p' || body.resolutionMode === 'direct') ? body.resolutionMode : 'auto';
            var drmChecked = Boolean(body.drmMode);
            var rotChanged = (orientation !== prevRot);
            var rotUpdated = false;
            if (rotChanged) {
                var rotRes = writeHdmiRotateToConfig(orientation);
                rotUpdated = Boolean(rotRes && rotRes.ok);
            }
            saveWallConfigPartial({
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
                drmMode: drmChecked,
                videoOutputMode: drmChecked ? 'drm' : ((wallConfig.videoOutputMode === 'drm') ? 'auto' : (wallConfig.videoOutputMode || 'auto')),
                resolutionMode: resMode,
                hdmi720p: (body.hdmi720p === undefined) ? true : Boolean(body.hdmi720p),
                orientationOverride: rotChanged ? (!rotUpdated) : Boolean(wallConfig.orientationOverride)
            });
            mpvSafeFallback = false;
            lastAppliedHdmiRes = '';
            applyDisplayResolution720pIfNeeded(true);
            applyDisplayRotationIfNeeded(null, true);

            clearWallDerivedCaches();
            blockPlaying = 0;
            stopOmx(function () {
                setTimeout(function () { checkSchedule(); }, 250);
            });

            res.json({
                ok: true,
                config: getWallConfigPublic(),
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
        playlistPos: wallMasterState.playlistPos || 0,
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
