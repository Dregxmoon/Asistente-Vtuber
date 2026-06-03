const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const MARGIN = 12;
const SIZES = { small: [280, 350], medium: [360, 450], large: [480, 600] };

let mainWindow;
let tray;
let isClickThrough = false;

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

function getBottomRightBounds(width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - width - MARGIN),
    y: Math.round(workArea.y + workArea.height - height - MARGIN),
    width,
    height,
  };
}

function placeBottomRight(width, height) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBounds(getBottomRightBounds(width, height));
}

function createWindow() {
  const [w, h] = SIZES.medium;

  mainWindow = new BrowserWindow({
    ...getBottomRightBounds(w, h),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    focusable: false,
    ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      backgroundThrottling: true,
      offscreen: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setFrameRate(30);

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`RENDERER [${level}] ${sourceId}:${line} - ${message}`);
  });

  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('hide', () => {
    mainWindow.webContents.send('app-visibility', false);
  });
  mainWindow.on('show', () => {
    mainWindow.webContents.send('app-visibility', true);
  });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));
}

function sendView(view) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('set-view', view);
  }
}

function setClickThrough(enabled) {
  isClickThrough = enabled;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  mainWindow.webContents.send('clickthrough-status', enabled);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      id: 'clickthrough',
      label: 'Pasar clics (usar otras apps)',
      type: 'checkbox',
      checked: isClickThrough,
      click: (item) => setClickThrough(item.checked),
    },
    { type: 'separator' },
    { label: 'Encuadre: cuerpo completo', click: () => sendView('full') },
    { label: 'Encuadre: medio cuerpo', click: () => sendView('half') },
    { label: 'Encuadre: cabeza', click: () => sendView('head') },
    { type: 'separator' },
    {
      label: 'Mostrar / ocultar',
      click: () => {
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
      },
    },
    { label: 'Tamaño pequeño', click: () => placeBottomRight(...SIZES.small) },
    { label: 'Tamaño mediano', click: () => placeBottomRight(...SIZES.medium) },
    { label: 'Tamaño grande', click: () => placeBottomRight(...SIZES.large) },
    { label: 'Esquina inferior derecha', click: () => {
      const [w, h] = mainWindow.getSize();
      placeBottomRight(w, h);
    }},
    { type: 'separator' },
    { label: 'Cerrar', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('VTuber Overlay');
  tray.setContextMenu(buildTrayMenu());
}

ipcMain.on('drag-window', (e, { deltaX, deltaY }) => {
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + deltaX, y + deltaY);
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  setClickThrough(true);

  screen.on('display-metrics-changed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getSize();
    placeBottomRight(w, h);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
