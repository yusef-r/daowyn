export type TransactionId = string

export type FeedEventType = 'EnteredPool' | 'OverageRefunded' | 'WinnerPicked' | string

export interface FeedEntry {
  // canonical identifiers
  txHash?: string | TransactionId
  logIndex?: number
  blockNumber?: number
  timestamp?: number

  // event type and payload
  type: FeedEventType

  // domain fields (optional depending on event)
  participant?: string
  winner?: string

  // amounts can come as bigint (from mapping) or number
  amount?: bigint | number
  prize?: bigint | number

  // flexible maps for actors/amounts if needed
  actors?: Record<string, string>
  amounts?: Record<string, bigint | number>
}