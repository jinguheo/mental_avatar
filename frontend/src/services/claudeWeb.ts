import { callMcpTool } from './mcp'

export async function streamClaudeWeb(
  sessionKey: string,
  mcpEndpoint: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  system: string,
  onDelta: (text: string) => void,
): Promise<string> {
  const result = await callMcpTool<{ text: string }>(mcpEndpoint, 'claude.chat', {
    session_key: sessionKey,
    messages,
    system,
  })
  const text = result.text || ''
  if (text) onDelta(text)
  return text
}

export async function claudeWebCaptureSession(mcpEndpoint: string): Promise<string> {
  const result = await callMcpTool<{ sessionKey: string }>(
    mcpEndpoint,
    'claude.capture_session',
    { timeout: 120 },
    130_000,
  )
  if (!result.sessionKey) throw new Error('세션 키를 가져오지 못했습니다.')
  return result.sessionKey
}
