// What the transcript row shows for one exec call, by tool_use_id.
export type CodemodeRun = {
  title: string
  calls: number
  failed: number
  denied: number
  isDone: boolean
  isOk: boolean
  seconds: number
}

export type CodemodeJson =
  | null
  | boolean
  | number
  | string
  | CodemodeJson[]
  | { [key: string]: CodemodeJson }

declare module 'claude-code' {
  interface PluginState {
    codemode: {
      // The store's keys, one list per session id.
      keys: StateFamily<string[]>
      // One value per `<session id>/<key>`.
      values: StateFamily<CodemodeJson>
      // The full description of each tool the engine rendered, by tool name.
      descriptions: StateFamily<string>
      // Live progress of each exec call, by tool_use_id.
      runs: StateFamily<CodemodeRun>
      // Whether the person expanded a row, by tool_use_id.
      expanded: StateFamily<boolean>
    }
  }
}
