export function normalizeServerUrl(input: string) {
  const text = input.trim()
  if (!text) return
  const url = /^https?:\/\//.test(text) ? text : `http://${text}`
  return url.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignore = false) {
  if (!conn) return ""
  if (conn.displayName && !ignore) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

export namespace ServerConnection {
  type Base = { displayName?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  export type Http = {
    type: "http"
    http: HttpBase
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & ({ variant: "base" } | { variant: "wsl"; distro: string }) &
    Base

  export type Ssh = {
    type: "ssh"
    host: string
    http: HttpBase
  } & Base

  export type Any = Http | Sidecar | Ssh

  export type Key = string & { _brand: "Key" }

  export const Key = {
    make(value: string) {
      return value as Key
    },
  }

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar":
        return conn.variant === "wsl" ? Key.make(`wsl:${conn.distro}`) : Key.make("sidecar")
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }
}
