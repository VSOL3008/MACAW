import "@/index.css"
import { MarkedProvider } from "@macaw/ui/context/marked"
import { MetaProvider } from "@solidjs/meta"
import type { BaseRouterProps } from "@solidjs/router"
import type { Component, JSX, ParentProps } from "solid-js"
import { CommandProvider } from "@/context/command"
import { LanguageProvider, type Locale } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { MacawApp } from "@/macaw"

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <MarkedProvider>
        <LanguageProvider locale={props.locale}>{props.children}</LanguageProvider>
      </MarkedProvider>
    </MetaProvider>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  const server = props.servers?.find((item) => ServerConnection.key(item) === props.defaultServer) ?? props.servers?.[0]
  return (
    <CommandProvider>
      {props.children}
      {server ? <MacawApp server={server} /> : <div class="macaw-error-screen">No server available.</div>}
    </CommandProvider>
  )
}
