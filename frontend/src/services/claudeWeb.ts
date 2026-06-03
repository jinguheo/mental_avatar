import { callMcpTool } from './mcp'

// Anthropic API 직접 호출 (MCP 없이)
async function callAnthropicDirect(
  apiKey: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  system: string,
  onDelta: (text: string) => void,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system,
      messages,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Anthropic API error ${res.status}`)
  }
  const data = await res.json()
  const text = data.content?.[0]?.text || ''
  if (text) onDelta(text)
  return text
}

export async function streamClaudeWeb(
  sessionKey: string,
  mcpEndpoint: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  system: string,
  onDelta: (text: string) => void,
  anthropicApiKey?: string,
): Promise<string> {
  // MCP 서버 없고 Anthropic API 키 있으면 직접 호출
  if ((!mcpEndpoint || !mcpEndpoint.trim()) && anthropicApiKey?.trim()) {
    return callAnthropicDirect(anthropicApiKey, messages, system, onDelta)
  }
  // MCP 서버 통해 claude.ai 호출
  if (!mcpEndpoint?.trim()) {
    throw new Error('설정에서 MCP 엔드포인트 또는 Anthropic API Key를 입력해주세요.')
  }
  const result = await callMcpTool<{ text: string }>(mcpEndpoint, 'claude.chat', {
    session_key: sessionKey,
    messages,
    system,
  })
  const text = result.text || ''
  if (text) onDelta(text)
  return text
}

// 캐시된 세션키 빠르게 조회 (앱 시작 시 자동 호출용)
export async function claudeWebAutoConnect(mcpEndpoint: string): Promise<string | null> {
  try {
    const result = await callMcpTool<{ sessionKey: string }>(
      mcpEndpoint,
      'claude.capture_session',
      { timeout: 10, quick_only: true },
      12_000,
    )
    return result.sessionKey || null
  } catch {
    return null
  }
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
