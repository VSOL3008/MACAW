import { createSimpleContext } from "@macaw/ui/context/helper"

type Fn = () => void

export const { use: useCommand, provider: CommandProvider } = createSimpleContext({
  name: "Command",
  init: () => {
    const map = new Map<string, Fn>()
    return {
      register(id: string, fn: Fn) {
        map.set(id, fn)
        return () => {
          if (map.get(id) === fn) map.delete(id)
        }
      },
      trigger(id: string) {
        map.get(id)?.()
      },
    }
  },
})
