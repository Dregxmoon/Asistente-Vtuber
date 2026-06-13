/**
 * OSSensor.js — Fase 2 (mejorado)
 *
 * Detecta:
 *  - Qué app/ventana tiene el foco en Windows y cuánto tiempo lleva ahí.
 *  - TODAS las ventanas visibles abiertas en el sistema (no solo la activa),
 *    con su título — útil para que March sepa "tienes VS Code, Edge,
 *    Discord y Spotify abiertos" sin depender solo de la ventana en foco.
 *  - Historial de apps usadas durante el día.
 *
 * Implementación: polling via PowerShell cada 5s.
 * Sin dependencias nativas — funciona en cualquier entorno Electron/Windows.
 *
 * Emite al EventBus:
 *   os:app-changed     — cuando cambia la app activa
 *   os:app-tick        — cada poll si la app no cambió (para actualizar elapsed)
 *   os:windows-updated — cada poll, con la lista actual de ventanas abiertas
 *   os:history-updated — cuando se guarda una entrada en el historial
 *
 * LIMITACIÓN CONOCIDA: para navegadores (Edge/Chrome/Firefox) solo se ve
 * el título de la ventana, que normalmente corresponde a la PESTAÑA ACTIVA
 * de esa ventana. No es posible ver pestañas en background sin una
 * extensión de navegador (eso quedaría para Fase 3 / Tool Layer).
 *
 * FIX previo: $PID es una variable automática de solo lectura en PowerShell
 * (PID de la sesión de powershell.exe). Renombrado a $procId.
 *
 * FIX encoding: se fuerza UTF-8 en la salida de PowerShell
 * ([Console]::OutputEncoding) y se decodifica el stdout del proceso
 * como UTF-8 en Node, para evitar mojibake en títulos con acentos/emoji.
 */

const { spawn }    = require('child_process');
const { getEventBus } = require('../event-bus/EventBus.js');

// Apps que ignoramos por completo (sistema, overlay propio, etc.)
const IGNORED_APPS = [
  'explorer', 'SearchHost', 'ShellExperienceHost', 'StartMenuExperienceHost',
  'LockApp', 'LogonUI', 'dwm', 'taskhostw', 'RuntimeBroker',
  'TextInputHost', 'ApplicationFrameHost', 'SystemSettings',
  'vtuber-overlay', 'electron', // nuestro propio proceso
];

// Mapeo de nombres de proceso a nombres legibles
const APP_NAMES = {
  'Code':           'Visual Studio Code',
  'code':           'Visual Studio Code',
  'cursor':         'Cursor',
  'chrome':         'Google Chrome',
  'msedge':         'Microsoft Edge',
  'firefox':        'Firefox',
  'Discord':        'Discord',
  'discord':        'Discord',
  'Slack':          'Slack',
  'slack':          'Slack',
  'WINWORD':        'Microsoft Word',
  'EXCEL':          'Microsoft Excel',
  'POWERPNT':       'PowerPoint',
  'notion':         'Notion',
  'obsidian':       'Obsidian',
  'figma':          'Figma',
  'Figma':          'Figma',
  'spotify':        'Spotify',
  'Spotify':        'Spotify',
  'WhatsApp':       'WhatsApp',
  'Telegram':       'Telegram',
  'WindowsTerminal':'Terminal',
  'cmd':            'Símbolo del sistema',
  'powershell':     'PowerShell',
  'wt':             'Terminal',
  'notepad':        'Bloc de notas',
  'notepad++':      'Notepad++',
  'sublime_text':   'Sublime Text',
  'idea64':         'IntelliJ IDEA',
  'pycharm64':      'PyCharm',
  'webstorm64':     'WebStorm',
  'postman':        'Postman',
  'insomnia':       'Insomnia',
  'vlc':            'VLC',
  'mpc-hc64':       'Media Player Classic',
  // Sistema / archivos / configuración — para que también salgan "bonitos"
  'explorer':       'Explorador de archivos',
  'SystemSettings': 'Configuración de Windows',
  'ApplicationFrameHost': 'Aplicación de Windows',
};

// Categorías de apps para el InitiativeEngine
const APP_CATEGORIES = {
  code:     ['Code', 'code', 'cursor', 'idea64', 'pycharm64', 'webstorm64', 'sublime_text', 'notepad++'],
  terminal: ['WindowsTerminal', 'cmd', 'powershell', 'wt'],
  browser:  ['chrome', 'msedge', 'firefox'],
  design:   ['figma', 'Figma'],
  docs:     ['WINWORD', 'EXCEL', 'POWERPNT', 'notion', 'obsidian', 'notepad'],
  chat:     ['Discord', 'discord', 'Slack', 'slack', 'WhatsApp', 'Telegram'],
  media:    ['spotify', 'Spotify', 'vlc', 'mpc-hc64'],
  api:      ['postman', 'insomnia'],
  files:    ['explorer'],
  system:   ['SystemSettings', 'ApplicationFrameHost'],
};

/**
 * Script PowerShell:
 *  1. Obtiene la ventana en foco (proceso + título).
 *  2. Enumera TODAS las ventanas top-level visibles con título no vacío,
 *     usando EnumWindows + IsWindowVisible + GetWindowTextLength.
 *
 * Salida (líneas separadas por \n):
 *   Línea 1: FOCUS|<procName>|<title>
 *   Líneas siguientes: WIN|<procName>|<title>   (una por ventana visible)
 *
 * Se fuerza UTF-8 en la salida para evitar mojibake con acentos/emoji.
 */
const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    public static List<IntPtr> GetVisibleWindows() {
        var result = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) {
                result.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

function Get-ProcTitle($hwnd) {
    $sb = New-Object System.Text.StringBuilder 512
    [Win32]::GetWindowText($hwnd, $sb, 512) | Out-Null
    $procId = 0
    [Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    $procName = "unknown"
    try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        $procName = $proc.ProcessName
    } catch {}
    return "$procName|$($sb.ToString())"
}

# 1. Ventana en foco
$hwndFocus = [Win32]::GetForegroundWindow()
Write-Output "FOCUS|$(Get-ProcTitle $hwndFocus)"

# 2. Todas las ventanas visibles con título
foreach ($hwnd in [Win32]::GetVisibleWindows()) {
    Write-Output "WIN|$(Get-ProcTitle $hwnd)"
}
`.trim();

class OSSensor {
  constructor(stateGraph) {
    this._graph        = stateGraph;
    this._bus          = getEventBus();
    this._polling      = null;
    this._currentApp   = null;
    this._currentTitle = null;
    this._appStart     = null;
    this._openWindows  = [];  // [{app, friendlyName, title, category}]
    this._history      = [];  // [{app, friendlyName, title, start, end, duration, category}]
    this._maxHistory   = 100; // máximo entradas en memoria
    this._running      = false;
    this._pollMs       = 5000; // cada 5 segundos
  }

  /** Inicia el sensor. */
  start() {
    if (this._running) return;
    this._running = true;
    console.log('[os-sensor] iniciado (poll cada 5s)');
    this._poll();
    this._polling = setInterval(() => this._poll(), this._pollMs);
  }

  /** Detiene el sensor. */
  stop() {
    if (this._polling) {
      clearInterval(this._polling);
      this._polling = null;
    }
    this._running = false;
    console.log('[os-sensor] detenido');
  }

  /** Devuelve el contexto actual del OS. */
  getCurrentContext() {
    const elapsed = this._appStart
      ? Math.round((Date.now() - this._appStart) / 1000)
      : 0;

    return {
      app:          this._currentApp,
      friendlyName: this._getFriendlyName(this._currentApp),
      title:        this._currentTitle,
      category:     this._getCategory(this._currentApp),
      elapsed,
      elapsedFormatted: this._formatElapsed(elapsed),
      openWindows:  this.getOpenWindows(),
      openWindowsSummary: this.getOpenWindowsSummary(),
      history:      this.getTodayHistory(),
    };
  }

  /**
   * Devuelve la lista de ventanas abiertas actualmente, deduplicada
   * y con nombres amigables. Cada entrada:
   *   { app, friendlyName, title, category, focused }
   */
  getOpenWindows() {
    return this._openWindows.map(w => ({
      ...w,
      focused: w.app === this._currentApp && w.title === this._currentTitle,
    }));
  }

  /**
   * Resumen compacto de ventanas abiertas para inyectar en el prompt.
   * Ej: "Visual Studio Code (OSSensor.js), Microsoft Edge (GitHub - Dregxmoon),
   *      Discord, Spotify"
   */
  getOpenWindowsSummary() {
    if (!this._openWindows.length) return null;
    return this._openWindows.map(w => {
      const cleanTitle = this._cleanTitle(w.app, w.title);
      return cleanTitle ? `${w.friendlyName} (${cleanTitle})` : w.friendlyName;
    }).join(', ');
  }

  /** Historial de hoy (desde medianoche). */
  getTodayHistory() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTs = startOfDay.getTime();
    return this._history.filter(e => e.start >= startTs);
  }

  /** Resumen del historial de hoy para el LLM. */
  getTodaySummary() {
    const today = this.getTodayHistory();
    if (!today.length) return null;

    // Agrupar por app y sumar duración
    const byApp = {};
    for (const entry of today) {
      const key = entry.friendlyName || entry.app;
      if (!byApp[key]) byApp[key] = 0;
      byApp[key] += entry.duration || 0;
    }

    // Ordenar por tiempo
    const sorted = Object.entries(byApp)
      .sort(([,a],[,b]) => b - a)
      .slice(0, 8);

    const lines = sorted.map(([app, secs]) =>
      `${app} (${this._formatElapsed(secs)})`
    );

    return lines.join(', ');
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  _poll() {
    this._runPS(PS_SCRIPT, (err, output) => {
      if (err || !output) return;

      const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return;

      let focus = null;
      const windows = [];

      for (const line of lines) {
        const sepIdx = line.indexOf('|');
        if (sepIdx === -1) continue;
        const kind = line.slice(0, sepIdx);
        const rest = line.slice(sepIdx + 1);

        const partsIdx = rest.indexOf('|');
        if (partsIdx === -1) continue;
        const procName = rest.slice(0, partsIdx).trim();
        const title    = rest.slice(partsIdx + 1).trim();

        if (!procName || procName === 'unknown') continue;
        if (IGNORED_APPS.some(ig => procName.toLowerCase().includes(ig.toLowerCase()))) continue;

        if (kind === 'FOCUS') {
          focus = { procName, title };
        } else if (kind === 'WIN') {
          windows.push({
            app:          procName,
            friendlyName: this._getFriendlyName(procName),
            title,
            category:     this._getCategory(procName),
          });
        }
      }

      // Deduplicar ventanas por (app + title)
      const seen = new Set();
      const dedup = [];
      for (const w of windows) {
        const key = `${w.app}::${w.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(w);
      }
      this._openWindows = dedup;
      this._bus.emit('os:windows-updated', { windows: dedup });

      // Procesar ventana en foco (igual que antes)
      if (!focus) return;
      this._processFocus(focus.procName, focus.title);
    });
  }

  _processFocus(procName, title) {
    const elapsed = this._appStart
      ? Math.round((Date.now() - this._appStart) / 1000)
      : 0;

    if (procName !== this._currentApp) {
      // App cambió — guardar la anterior en historial
      if (this._currentApp && this._appStart) {
        this._saveToHistory(this._currentApp, this._currentTitle, this._appStart, Date.now());
      }

      const prev = this._currentApp;
      this._currentApp   = procName;
      this._currentTitle = title;
      this._appStart     = Date.now();

      this._bus.emit('os:app-changed', {
        app:          procName,
        friendlyName: this._getFriendlyName(procName),
        title,
        category:     this._getCategory(procName),
        elapsed:      0,
        prev,
        prevFriendly: this._getFriendlyName(prev),
      });

      console.log(`[os-sensor] app: ${this._getFriendlyName(procName)} — "${title.slice(0, 60)}"`);
    } else {
      // Misma app — emitir tick con tiempo actualizado
      this._currentTitle = title; // el título puede cambiar (ej: archivo abierto, pestaña)
      this._bus.emit('os:app-tick', {
        app:          procName,
        friendlyName: this._getFriendlyName(procName),
        title,
        category:     this._getCategory(procName),
        elapsed,
        elapsedFormatted: this._formatElapsed(elapsed),
      });
    }
  }

  _saveToHistory(app, title, start, end) {
    const duration = Math.round((end - start) / 1000);
    if (duration < 5) return; // ignorar flashes de menos de 5s

    const entry = {
      app,
      friendlyName: this._getFriendlyName(app),
      title:        title?.slice(0, 120) || '',
      category:     this._getCategory(app),
      start,
      end,
      duration,
    };

    this._history.push(entry);
    if (this._history.length > this._maxHistory) this._history.shift();

    // Guardar en StateGraph si está disponible
    if (this._graph?._ready) {
      try {
        this._graph.saveAppHistory(entry);
      } catch(e) {
        // Silencioso — no interrumpir por esto
      }
    }

    this._bus.emit('os:history-updated', {
      latest:  entry,
      todayCount: this.getTodayHistory().length,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _getFriendlyName(procName) {
    if (!procName) return null;
    return APP_NAMES[procName] || procName;
  }

  _getCategory(procName) {
    if (!procName) return 'other';
    const lower = procName.toLowerCase();
    for (const [cat, apps] of Object.entries(APP_CATEGORIES)) {
      if (apps.some(a => a.toLowerCase() === lower)) return cat;
    }
    return 'other';
  }

  _formatElapsed(seconds) {
    if (!seconds || seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  }

  /**
   * Limpia títulos de ventana para que sean más legibles/útiles en el prompt.
   * Quita el sufijo "— Microsoft Edge" / "- Google Chrome" / "y N páginas más"
   * que solo añade ruido y puede llevar al LLM a inventar pestañas que no
   * conoce. Solo describimos lo que el título realmente dice.
   */
  _cleanTitle(procName, title) {
    if (!title) return '';
    let t = title;

    // Quitar "y N páginas más" / "and N more pages" — corresponde solo
    // a la pestaña ACTIVA de esa ventana, no debemos sugerir que
    // conocemos el contenido de las otras.
    t = t.replace(/\s*[-–—]?\s*y \d+\s+p[áa]gin\w* m[áa]s/gi, '');
    t = t.replace(/\s*[-–—]?\s*and \d+\s+more\s*/gi, '');

    // Quitar sufijos típicos de navegador
    t = t.replace(/\s*[-–—]\s*(Microsoft\??\s*Edge|Google Chrome|Mozilla Firefox)\s*$/i, '');

    // Quitar sufijo "- Visual Studio Code"
    t = t.replace(/\s*[-–—]\s*Visual Studio Code\s*$/i, '');

    return t.trim();
  }

  _runPS(script, callback) {
    let output = '';
    let error  = '';

    try {
      const proc = spawn('powershell', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-Command', script,
      ], { windowsHide: true });

      // Forzar decodificación UTF-8 del stdout para evitar mojibake
      // en títulos con acentos/emoji (combinado con
      // [Console]::OutputEncoding = UTF8 dentro del script PS).
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      proc.stdout.on('data', d => { output += d; });
      proc.stderr.on('data', d => { error  += d; });
      proc.on('close', (code) => {
        if (code !== 0 || error) {
          callback(new Error(error || `code ${code}`), null);
        } else {
          callback(null, output.trim());
        }
      });
      proc.on('error', (e) => {
        callback(e, null);
      });
    } catch(e) {
      callback(e, null);
    }
  }
}

module.exports = { OSSensor, APP_CATEGORIES, APP_NAMES };