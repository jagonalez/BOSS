import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { IpcChannels, type MenuCommand } from '@shared/ipc'

const REPOSITORY = 'https://github.com/jagonalez/ralf'
const SITE = 'https://getboss.dev'

/** What About shows.
 *
 *  Electron's default panel gives the name, the version and nothing else — not
 *  what the app is for, not where to find it. Version is read from package.json
 *  so a release cannot ship a stale number here. */
function aboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    copyright: `MIT licensed · ${SITE}`,
    credits: 'A desktop workspace for coding agents: threads own their terminals, files, reviews and browsers, and each can run on its own Git worktree.',
    // Windows and Linux only. macOS takes the icon from the app bundle, so in
    // development it shows Electron's — the packaged build has its own icns
    // and shows that.
    iconPath: join(app.getAppPath(), 'resources', 'icons', '256x256.png')
  })
}

/** Send a menu item to the window that has focus.
 *
 *  The menu names an action; the renderer performs it. Everything here has a
 *  button somewhere in the app too, so this is a second way to reach a thing
 *  rather than a second implementation of it. */
function send(command: MenuCommand): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  target?.webContents.send(IpcChannels.MenuCommand, command)
}

/** The application menu.
 *
 *  Without one, Electron supplies a default that calls the app "Electron" and
 *  offers nothing it can do. The Edit menu earns its place even though nothing
 *  in it is ours: the standard roles are what bind copy, paste and select-all
 *  to their shortcuts, and text fields behave oddly without them. */
export function buildAppMenu(): void {
  aboutPanel()
  const mac = process.platform === 'darwin'

  const appMenu: MenuItemConstructorOptions[] = mac
    ? [{
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings.open') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      }]
    : []

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        { label: 'New Thread', accelerator: 'CmdOrCtrl+N', click: () => send('thread.new') },
        { label: 'New Chat', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('thread.new-global') },
        { label: 'New View', accelerator: 'CmdOrCtrl+Alt+N', click: () => send('view.new') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('tab.close') },
        ...(mac ? [] : [
          { type: 'separator' } as MenuItemConstructorOptions,
          { label: 'Settings…', accelerator: 'Ctrl+,', click: () => send('settings.open') } as MenuItemConstructorOptions,
          { type: 'separator' } as MenuItemConstructorOptions,
          { role: 'quit' } as MenuItemConstructorOptions
        ])
      ]
    },
    {
      // Ours by name only. These roles are what make the shortcuts work.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Split Left and Right', accelerator: 'CmdOrCtrl+D', click: () => send('pane.split-horizontal') },
        { label: 'Split Top and Bottom', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('pane.split-vertical') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: mac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'close' }]
    },
    {
      role: 'help',
      submenu: [
        { label: `${app.name} Website`, click: () => void shell.openExternal(SITE) },
        { label: `${app.name} on GitHub`, click: () => void shell.openExternal(REPOSITORY) },
        { label: 'Report an Issue', click: () => void shell.openExternal(`${REPOSITORY}/issues/new`) },
        { type: 'separator' },
        // Kept, but here rather than in View. Everyone using this is a
        // developer, and a console is what a bug report needs — this is where
        // someone looks when something has gone wrong.
        { role: 'toggleDevTools', label: 'Developer Tools' },
        // macOS has About in the application menu; nowhere else does, so it
        // needs a home here and an explicit call to open the panel.
        ...(mac ? [] : [
          { type: 'separator' } as MenuItemConstructorOptions,
          { label: `About ${app.name}`, click: () => app.showAboutPanel() } as MenuItemConstructorOptions
        ])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
