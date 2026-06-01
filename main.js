const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let mainWindow;
let tray;
let isClickThrough = false;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 400,
    height: 500,
    x: width - 420,
    y: height - 520,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  // Always on top — nivel máximo
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true);

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));

  // Abrir DevTools solo en desarrollo
  // mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function createTray() {
  // Ícono simple en la bandeja del sistema
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🖱️ Click-through (atravesar clics)',
      type: 'checkbox',
      checked: false,
      click: (item) => {
        isClickThrough = item.checked;
        mainWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
      },
    },
    {
      label: '👁️ Mostrar/Ocultar',
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
        }
      },
    },
    { type: 'separator' },
    {
      label: '📐 Pequeño (300x375)',
      click: () => mainWindow.setSize(300, 375),
    },
    {
      label: '📐 Mediano (400x500)',
      click: () => mainWindow.setSize(400, 500),
    },
    {
      label: '📐 Grande (550x688)',
      click: () => mainWindow.setSize(550, 688),
    },
    { type: 'separator' },
    {
      label: '❌ Cerrar',
      click: () => app.quit(),
    },
  ]);

  tray.setToolTip('VTuber Overlay');
  tray.setContextMenu(contextMenu);
}

// IPC: el renderer puede pedir toggle de click-through
ipcMain.on('toggle-clickthrough', () => {
  isClickThrough = !isClickThrough;
  mainWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
  mainWindow.webContents.send('clickthrough-status', isClickThrough);
});

ipcMain.on('close-app', () => app.quit());

ipcMain.on('drag-window', (e, { deltaX, deltaY }) => {
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + deltaX, y + deltaY);
});

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});