export interface Settings {
  claudeSessionKey: string
  mcpEndpoint: string
  anthropicApiKey: string
  aiProvider: 'ollama' | 'claude'
  ollamaEndpoint: string
  ollamaModel: string
}

export const DEFAULT_SETTINGS: Settings = {
  claudeSessionKey: '',
  mcpEndpoint: 'http://127.0.0.1:8765/mcp',
  anthropicApiKey: '',
  aiProvider: 'ollama',
  ollamaEndpoint: 'http://localhost:11434/v1',
  ollamaModel: 'gemma4:e2b',
}
