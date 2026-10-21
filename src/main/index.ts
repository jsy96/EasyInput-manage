import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)

let mainWindow: BrowserWindow | null = null

async function getDesktopWallpaper(): Promise<{ dataUrl: string | null; source: string | null }> {
  if (process.platform !== 'darwin') return { dataUrl: null, source: null }

  let temporaryDirectory: string | undefined
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', [
      '-e', 'tell application "System Events" to get picture of current desktop',
    ], { timeout: 10_000 })
    const source = stdout.trim()
    if (!source) return { dataUrl: null, source: null }

    temporaryDirectory = await mkdtemp(join(tmpdir(), 'easyinput-wallpaper-'))
    const pngPath = join(temporaryDirectory, 'wallpaper.png')
    await execFileAsync('/usr/bin/sips', [
      '-s', 'format', 'png', '--resampleWidth', '1920', source, '--out', pngPath,
    ], { timeout: 20_000 })
    const png = await readFile(pngPath)
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, source }
  } catch {
    return { dataUrl: null, source: null }
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

function registerSerialPermissions(): void {
  const appSession = session.defaultSession
  appSession.setPermissionCheckHandler((_contents, permission) => permission === 'serial')
  appSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'serial')
  })

  appSession.on('select-serial-port', (event, ports, _contents, callback) => {
    event.preventDefault()
    if (!mainWindow) {
      callback('')
      return
    }

    if (ports.length === 0) {
      void dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '未检测到 USB 串口',
        message: '当前没有可用的 USB 串口设备。',
        detail: '请检查 USB 数据线和开发板供电后重试。',
        buttons: ['知道了'],
        noLink: true,
      }).then(() => callback('')).catch(() => callback(''))
      return
    }

    const labels = ports.map((port, index) => {
      const name = port.displayName || port.portName || '未知串口设备'
      const vendorId = port.vendorId?.toUpperCase() ?? '未知'
      const productId = port.productId?.toUpperCase() ?? '未知'
      return `${name} · VID ${vendorId} / PID ${productId} · 设备 ${index + 1}`
    })

    void dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '选择 USB 串口',
      message: '选择要连接的 USB 串口设备',
      detail: '列表会显示每个设备的 VID 和 PID。请选择当前连接的 EasyInput 开发板。',
      buttons: [...labels, '取消'],
      cancelId: labels.length,
      defaultId: 0,
      noLink: true,
    }).then(({ response }) => {
      callback(response < ports.length ? ports[response].portId : '')
    }).catch(() => callback(''))
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    title: 'EasyInput Studio',
    backgroundColor: '#0a111b',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('desktop:get-wallpaper', getDesktopWallpaper)
  ipcMain.handle('network:get-addresses', () => Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => !address.internal)
      .map((address) => ({ name, address: address.address, family: String(address.family), netmask: address.netmask, mac: address.mac })),
  ))
  registerSerialPermissions()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
