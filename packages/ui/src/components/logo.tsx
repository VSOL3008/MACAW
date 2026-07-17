import { ComponentProps } from "solid-js"
import mark from "../assets/macaw-logo.svg"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 196 200"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <image href={mark} width="196" height="200" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <image href={mark} y="10" width="80" height="80" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      classList={{ [props.class ?? ""]: !!props.class }}
      aria-hidden="true"
    >
      <image href={mark} x="96.42" width="41.16" height="42" />
    </svg>
  )
}
