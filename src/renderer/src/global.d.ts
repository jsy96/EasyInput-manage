/// <reference types="vite-plugin-pwa/client" />

import type { Serial } from 'w3c-web-serial'

declare global {
  interface EasyInputBluetoothCharacteristic extends EventTarget {
    readonly value: DataView | null
    startNotifications(): Promise<EasyInputBluetoothCharacteristic>
    writeValueWithResponse(value: BufferSource): Promise<void>
  }

  interface EasyInputBluetoothService {
    getCharacteristic(uuid: string): Promise<EasyInputBluetoothCharacteristic>
  }

  interface EasyInputBluetoothServer {
    readonly connected: boolean
    connect(): Promise<EasyInputBluetoothServer>
    disconnect(): void
    getPrimaryService(uuid: string): Promise<EasyInputBluetoothService>
  }

  interface EasyInputBluetoothDevice extends EventTarget {
    readonly name: string | null
    readonly gatt: EasyInputBluetoothServer | null
  }

  interface EasyInputBluetooth {
    requestDevice(options: {
      filters: Array<{ namePrefix: string }>
      optionalServices: string[]
    }): Promise<EasyInputBluetoothDevice>
  }

  interface Navigator {
    readonly serial: Serial
    readonly bluetooth?: EasyInputBluetooth
  }

}

export {}
