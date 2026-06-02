export interface Settings {
  claudeSessionKey: string
  mcpEndpoint: string
  anthropicApiKey: string
}

export const DEFAULT_SETTINGS: Settings = {
  claudeSessionKey: '',
  mcpEndpoint: 'http://127.0.0.1:8765/mcp',
  anthropicApiKey: '',
}
