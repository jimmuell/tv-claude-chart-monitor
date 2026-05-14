import { app, Menu, nativeImage } from 'electron';
import { menubar } from 'menubar';
import path from 'path';

const icon = nativeImage.createFromPath(
  path.join(app.getAppPath(), 'assets', 'iconTemplate.png')
);
icon.setTemplateImage(true);

const mb = menubar({
  index: app.isPackaged
    ? `file://${path.join(app.getAppPath(), 'dist', 'renderer', 'index.html')}`
    : 'http://localhost:5173',
  icon,
  browserWindow: {
    width: 420,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    resizable: false,
  },
  preloadWindow: true,
});

mb.on('ready', () => {
  app.dock?.hide();

  mb.tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Show Panel', click: () => mb.showWindow() },
      { label: 'Refresh Now', click: () => mb.showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    mb.tray.popUpContextMenu(menu);
  });
});
