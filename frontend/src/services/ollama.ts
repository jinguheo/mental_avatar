export async function streamChatOllama(
  baseUrl: string,
  model: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  system: string,
  onDelta: (text: string) => void,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'gemma4:e2b',
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  })

  if (!response.ok) {
    throw new Error(`Ollama 오류: ${response.status} ${response.statusText}`)
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      if (trimmed.startsWith('data: ')) {
        try {
          const data = JSON.parse(trimmed.slice(6))
          const delta = data.choices?.[0]?.delta?.content || ''
          if (delta) { full += delta; onDelta(delta) }
        } catch { /**/ }
      }
    }
  }

  return full
}
