import { MCP_ENDPOINT } from '@/config'

export interface Settings {
  claudeSessionKey: string
  mcpEndpoint: string
  anthropicApiKey: string
  aiProvider: 'ollama' | 'claude'
  ollamaEndpoint: string
  ollamaModel: string
}

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

export const DEFAULT_SETTINGS: Settings = {
  claudeSessionKey: '',
  mcpEndpoint: MCP_ENDPOINT,
  anthropicApiKey: '',
  aiProvider: 'ollama',
  ollamaEndpoint: 'http://localhost:11434/v1',
  ollamaModel: 'gemma4:e2b',
}
