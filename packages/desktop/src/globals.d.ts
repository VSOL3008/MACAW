declare global {
  interface Window {
    __MACAW__?: {
      updaterEnabled?: boolean
      wsl?: boolean
      deepLinks?: string[]
    }
  }
}

export {}
