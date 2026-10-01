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
    }
  }
}
