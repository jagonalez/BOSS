/// <reference types="vite/client" />

import type { BossApi } from '../../shared/api'

declare global {
  interface Window {
    boss: BossApi
  }
}

export {}
