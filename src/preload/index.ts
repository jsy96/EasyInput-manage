import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('easyinputDesktop', {
  version: process.env.npm_package_version ?? '0.1.0',
  platform: process.platform,
  getDesktopWallpaper: () => ipcRenderer.invoke('desktop:get-wallpaper') as Promise<{
    dataUrl: string | null
    source: string | null
  }>,
  getNetworkAddresses: () => ipcRenderer.invoke('network:get-addresses') as Promise<Array<{
    name: string
    address: string
    family: string
    netmask: string
    mac: string
  }>>,
})
