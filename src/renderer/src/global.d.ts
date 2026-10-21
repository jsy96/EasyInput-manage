import type { Serial } from 'w3c-web-serial'

declare global {
  interface Navigator {
    readonly serial: Serial
  }

  interface Window {
    easyinputDesktop?: {
      version: string
      platform: string
      getDesktopWallpaper: () => Promise<{
        dataUrl: string | null
        source: string | null
      }>
      getNetworkAddresses: () => Promise<Array<{
        name: string
        address: string
        family: string
        netmask: string
        mac: string
      }>>
    }
  }
}

export {}
