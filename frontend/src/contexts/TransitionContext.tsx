import type { ReactNode } from 'react'

import { createContext, use, useState } from 'react'

interface TransitionContextType {
  isThemeSwitching: boolean
  disableRouteTransitions: () => void
  enableRouteTransitions: () => void
}

const TransitionContext = createContext<TransitionContextType>({
  isThemeSwitching: false,
  disableRouteTransitions: () => {},
  enableRouteTransitions: () => {},
})

export function TransitionProvider({ children }: { children: ReactNode }) {
  const [isThemeSwitching, setIsThemeSwitching] = useState(false)

  const disableRouteTransitions = () => setIsThemeSwitching(true)
  const enableRouteTransitions = () => setIsThemeSwitching(false)

  return (
    <TransitionContext
      value={{
        isThemeSwitching,
        disableRouteTransitions,
        enableRouteTransitions,
      }}
    >
      {children}
    </TransitionContext>
  )
}

export const useTransitionControl = () => use(TransitionContext)
