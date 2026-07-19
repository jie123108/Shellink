export type SessionState =
  | 'CONNECTING'
  | 'OUTPUTTING'
  | 'IDLE'
  | 'WAITING_INPUT'
  | 'DISCONNECTED'

export type InteractionMode = 'AUTO' | 'MANUAL'
