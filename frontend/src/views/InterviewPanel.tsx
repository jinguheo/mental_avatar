import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '../config'

// 심층 인터뷰 — 사용자가 요청할 때만 질문을 생성한다.
// 각 답은 높은 신뢰의 self_interview 지식으로 저장되며, 필요하면 직전 답을 바탕으로 한 질문을 더 받는다.

type Interview = {
  id: string
  question: string
  answer: string
  topic: string
  created_at: string
}

export default function InterviewPanel() {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [loadingQ, setLoadingQ] = useState(false)
  const [saving, setSaving] = useState(false)
  const [items, setItems] = useState<Interview[]>([])
  const [count, setCount] = useState(0)
  const [error, setError] = useState('')
  const [topic, setTopic] = useState('')   // 주제 지정(선택). 비우면 무작위
  const [focus, setFocus] = useState('')   // 초점 힌트(선택), 예: 사람들이 주로 헷갈리는 부분

  const loadList = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/interview/list`)
      const d = await r.json()
      setItems(d.items || [])
      setCount(d.count || 0)
    } catch {
      /* 서버 미연결 — 무시 */
    }
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  const getQuestion = useCallback(async () => {
    setLoadingQ(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (topic.trim()) params.set('topic', topic.trim())
      if (focus.trim()) params.set('focus', focus.trim())
      const qs = params.toString()
      const r = await fetch(`${API_BASE}/interview/question${qs ? `?${qs}` : ''}`)
      const d = await r.json()
      if (d.error) setError(d.error)
      else setQuestion(d.question || '')
      setAnswer('')
    } catch (e) {
      setError('질문을 가져오지 못했습니다 (서버 연결 확인).')
    } finally {
      setLoadingQ(false)
    }
  }, [topic, focus])

  const save = useCallback(async (): Promise<boolean> => {
    if (!question.trim() || !answer.trim()) return false
    setSaving(true)
    setError('')
    try {
      const r = await fetch(`${API_BASE}/interview/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer, topic }),
      })
      const d = await r.json()
      if (d.error) {
        setError(d.error)
        return false
      } else {
        setQuestion('')
        setAnswer('')
        await loadList()
        return true
      }
    } catch {
      setError('저장에 실패했습니다 (서버 연결 확인).')
      return false
    } finally {
      setSaving(false)
    }
  }, [question, answer, topic, loadList])

  const saveAndNext = useCallback(async () => {
    const saved = await save()
    if (saved) await getQuestion()
  }, [save, getQuestion])

  const saveAndDeepen = useCallback(async () => {
    const previousQuestion = question
    const previousAnswer = answer
    if (!previousQuestion.trim() || !previousAnswer.trim()) return
    const saved = await save()
    if (!saved) return

    setLoadingQ(true)
    setError('')
    try {
      const r = await fetch(`${API_BASE}/interview/followup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: previousQuestion, answer: previousAnswer, topic }),
      })
      const d = await r.json()
      if (d.error) setError(d.error)
      else setQuestion(d.question || '')
    } catch {
      setError('후속 질문을 만들지 못했습니다 (서버 연결 확인).')
    } finally {
      setLoadingQ(false)
    }
  }, [question, answer, topic, save])

  const remove = useCallback(
    async (id: string) => {
      try {
        await fetch(`${API_BASE}/interview/${id}`, { method: 'DELETE' })
        await loadList()
      } catch {
        /* ignore */
      }
    },
    [loadList],
  )

  return (
    <div className="view-canvas h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <header className="view-header -mx-4 -mt-5 border-x-0 px-4 py-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <p className="dashboard-kicker">나를 이해하는 대화</p>
          <h1 className="mt-1 text-xl font-semibold text-gray-950">심층 인터뷰</h1>
          <p className="mt-1 text-xs text-gray-500">
            경험, 가치관, 판단 기준을 차례로 기록합니다. 답을 저장한 뒤에는 근거·사례·예외를 묻는 후속 질문으로 더 깊게 이어갈 수 있습니다. (누적 {count}개)
          </p>
        </header>

        {/* 질문 받기 / 답변 */}
        <section className="view-panel p-4 sm:p-5">
          {/* 주제 지정(선택) — 비우면 내 관심사에서 무작위 */}
          <div className="mb-3 flex flex-col gap-2 rounded-lg border border-dashed border-surface-border bg-gray-50/60 px-3 py-3">
            <span className="dashboard-kicker">인터뷰 주제 (선택 — 비우면 내 기록에서 제안)</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={topic}
                onChange={e => setTopic(e.target.value)}
                placeholder="주제 (예: 일할 때의 판단 기준)"
                className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-400 sm:w-1/3"
              />
              <input
                value={focus}
                onChange={e => setFocus(e.target.value)}
                placeholder="특히 알고 싶은 점 (예: 일정과 품질이 충돌할 때)"
                className="w-full flex-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-400"
              />
            </div>
          </div>

          {!question ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm text-gray-500">준비되면 첫 질문을 받아, 실제 경험과 생각을 편하게 들려주세요.</p>
              <button
                type="button"
                onClick={getQuestion}
                disabled={loadingQ}
                className="inline-flex items-center gap-2 rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:opacity-50"
              >
                {loadingQ ? '질문 생성 중…' : '인터뷰 시작'}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-surface-border bg-gray-50 px-4 py-3">
                <span className="dashboard-kicker">아바타의 질문</span>
                <p className="mt-1 text-sm font-medium text-gray-950">{question}</p>
              </div>
              <textarea
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                placeholder="실제 사례, 판단 근거, 상황에 따른 예외까지 편하게 적어주세요…"
                rows={5}
                className="w-full resize-y rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !answer.trim()}
                  className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:opacity-50"
                >
                  {saving ? '저장 중…' : '저장'}
                </button>
                <button
                  type="button"
                  onClick={saveAndNext}
                  disabled={saving || !answer.trim()}
                  className="rounded-lg border border-surface-border bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                >
                  저장하고 새 주제 질문
                </button>
                <button
                  type="button"
                  onClick={saveAndDeepen}
                  disabled={saving || loadingQ || !answer.trim()}
                  className="rounded-lg border border-gray-950 bg-gray-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:opacity-50"
                >
                  {loadingQ ? '후속 질문 생성 중…' : '저장하고 더 깊게 묻기'}
                </button>
                <button
                  type="button"
                  onClick={getQuestion}
                  disabled={loadingQ}
                  className="rounded-lg px-3 py-2 text-sm text-gray-500 transition hover:text-gray-900 disabled:opacity-50"
                >
                  다른 질문
                </button>
              </div>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </section>

        {/* 지난 자문자답 */}
        <section className="view-panel overflow-hidden">
          <div className="border-b border-surface-border px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold text-gray-950">인터뷰 기록 ({count})</h2>
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-400 sm:px-5">아직 저장된 인터뷰 답변이 없습니다.</p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {items.map(it => (
                <li key={it.id} className="group flex items-start gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-gray-500">{it.question}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{it.answer}</p>
                    <p className="mt-1 text-[11px] text-gray-400">{it.created_at}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(it.id)}
                    title="삭제"
                    className="shrink-0 rounded-md px-2 py-1 text-gray-300 transition hover:bg-red-50 hover:text-red-600"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
