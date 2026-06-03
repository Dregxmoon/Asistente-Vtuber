const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const MARGIN = 12;
const SIZES = {
  small:  [300, 430],
  medium: [420, 600],
  large:  [560, 800],
};

let mainWindow;
let tray;
let isClickThrough = true; // Click-through activado por defecto

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

function getBottomRightBounds(width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width  - width  - MARGIN),
    y: Math.round(workArea.y + workArea.height - height - MARGIN),
    width,
    height,
  };
}

function placeBottomRight(width, height) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBounds(getBottomRightBounds(width, height));
}

function setClickThrough(enabled) {
  isClickThrough = enabled;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  mainWindow.webContents.send('clickthrough-status', enabled);
  if (tray) tray.setContextMenu(buildTrayMenu());
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
    focusable: false, // no roba foco
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setMenuBarVisibility(false);

  // Click-through activado desde el inicio
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.webContents.on('console-message', (e, level, msg, line) => {
    console.log(`[renderer] ${msg}`);
  });

  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: isClickThrough ? '🔒 Bloquear (mover ventana)' : '🖱️ Pasar clics (modo normal)',
      click: () => setClickThrough(!isClickThrough),
    },
    { type: 'separator' },
    { label: 'Tamaño pequeño',  click: () => placeBottomRight(...SIZES.small)  },
    { label: 'Tamaño mediano',  click: () => placeBottomRight(...SIZES.medium) },
    { label: 'Tamaño grande',   click: () => placeBottomRight(...SIZES.large)  },
    { label: 'Esquina inferior derecha', click: () => {
      const [w, h] = mainWindow.getSize();
      placeBottomRight(w, h);
    }},
    {
      label: 'Mostrar / ocultar',
      click: () => {
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
      },
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

// Desde el renderer: hover sobre el modelo activa/desactiva click-through
ipcMain.on('model-hover', (e, hovering) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Solo bloquea clics cuando el cursor está sobre el modelo
  mainWindow.setIgnoreMouseEvents(!hovering, { forward: true });
});

ipcMain.on('drag-window', (e, { deltaX, deltaY }) => {
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + deltaX, y + deltaY);
});

app.whenReady().then(() => {
  createWindow();
  createTray();

  screen.on('display-metrics-changed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getSize();
    placeBottomRight(w, h);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});