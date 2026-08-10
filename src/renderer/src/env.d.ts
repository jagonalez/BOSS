/// <reference types="vite/client" />

import type { RalfApi } from '../../shared/api'

declare global {
  interface Window {
    ralf: RalfApi
  }
}

export {}
