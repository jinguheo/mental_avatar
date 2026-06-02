export async function callMcpTool<T = unknown>(
  endpoint: string,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  const controller = timeoutMs ? new AbortController() : undefined
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined

  try {
    const res = await fetch(endpoint, {
      signal: controller?.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`)
    const json = await res.json()
    if (json.error) throw new Error(json.error.message || 'MCP error')
    const content = json.result?.content
    if (Array.isArray(content)) {
      const text = content.find((c: { type: string }) => c.type === 'text')?.text
      if (text) return JSON.parse(text) as T
    }
    return (json.result ?? {}) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}
