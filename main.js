const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const MARGIN = 12;
const WIN_W = 380;
const WIN_H = 580;

let mainWindow;
let tray;
let isClickThrough = true;
let currentView = 'full';

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

function getBottomRightBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width  - WIN_W - MARGIN),
    y: Math.round(workArea.y + workArea.height - WIN_H - MARGIN),
    width:  WIN_W,
    height: WIN_H,
  };
}

function setClickThrough(enabled) {
  isClickThrough = enabled;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  mainWindow.webContents.send('clickthrough-status', enabled);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function sendView(view) {
  currentView = view;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('set-view', view);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createWindow() {
  const views = ['full', 'half', 'head'];
  currentView = views[Math.floor(Math.random() * views.length)];

  mainWindow = new BrowserWindow({
    ...getBottomRightBounds(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    thickFrame: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.webContents.on('console-message', (e, level, msg) => {
    console.log(`[renderer] ${msg}`);
  });

  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      mainWindow.webContents.send('set-view', currentView);
      startAutoSwitch();
    }, 1500);
  });
}

function startAutoSwitch() {
  const views = ['full', 'half', 'head'];
  const scheduleNext = () => {
    const delay = (Math.random() * 20 + 20) * 1000;
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const options = views.filter(v => v !== currentView);
      const next = options[Math.floor(Math.random() * options.length)];
      sendView(next);
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: isClickThrough ? '🔒 Bloquear (mover ventana)' : '🖱️ Pasar clics',
      click: () => setClickThrough(!isClickThrough),
    },
    { type: 'separator' },
    { label: `${currentView === 'full' ? '✓ ' : ''}Cuerpo completo`, click: () => sendView('full') },
    { label: `${currentView === 'half' ? '✓ ' : ''}Medio cuerpo`,    click: () => sendView('half') },
    { label: `${currentView === 'head' ? '✓ ' : ''}Solo cabeza`,     click: () => sendView('head') },
    { type: 'separator' },
    {
      label: 'Mostrar / ocultar',
      click: () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(),
    },
    { type: 'separator' },
    { label: 'Cerrar', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('VTuber Overlay — March 7th');
  tray.setContextMenu(buildTrayMenu());
}

ipcMain.on('model-hover', (e, hovering) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(!hovering, { forward: true });
});

app.whenReady().then(() => {
  createWindow();
  createTray();

  screen.on('display-metrics-changed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setBounds(getBottomRightBounds());
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});