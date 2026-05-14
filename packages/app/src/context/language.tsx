import { createSimpleContext } from "@macaw/ui/context/helper"
import { createStore } from "solid-js/store"

export type Locale = "en" | "zh"

const DICT = {
  en: {
    "app.error.noServer": "No server available.",
  },
  zh: {
    "app.error.noServer": "No server available.",
  },
} as const

export function normalizeLocale(input?: string | null): Locale {
  if (!input) return "en"
  return input.toLowerCase().startsWith("zh") ? "zh" : "en"
}

export function loadLocaleDict(_locale: Locale) {
  return Promise.resolve()
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  init: (props: { locale?: Locale }) => {
    const [state, setState] = createStore({
      locale: normalizeLocale(props.locale),
    })
    return {
      get locale() {
        return state.locale
      },
      get intl() {
        return state.locale === "zh" ? "zh-Hans" : "en"
      },
      t(key: string) {
        return DICT[state.locale][key as keyof (typeof DICT)["en"]] ?? key
      },
      setLocale(locale: Locale) {
        setState("locale", normalizeLocale(locale))
      },
    }
  },
})
