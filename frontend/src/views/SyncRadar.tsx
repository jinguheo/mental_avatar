export type SyncAxis = { label: string; value: number; detail: string }

export default function SyncRadar({ axes, overall }: { axes: SyncAxis[]; overall: number }) {
  const center = 130
  const radius = 86
  const point = (index: number, scale: number) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / axes.length
    return [center + Math.cos(angle) * radius * scale, center + Math.sin(angle) * radius * scale]
  }
  const polygon = (scale: number) => axes.map((_, index) => point(index, scale).join(',')).join(' ')
  const safeAxes = axes.map(axis => ({ ...axis, value: Math.max(0, Math.min(100, axis.value)) }))

  return <div className="grid items-center gap-5 lg:grid-cols-[280px_1fr]">
    <div className="mx-auto w-full max-w-[280px]" role="img" aria-label={'기초 지식 축별 준비도: ' + safeAxes.map(axis => axis.label + ' ' + axis.value + '%').join(', ')}>
      <svg viewBox="-20 -20 300 300" className="w-full" aria-hidden="true">
        {[0.25, 0.5, 0.75, 1].map(level => <polygon key={level} points={polygon(level)} fill="none" stroke="#d1d5db" strokeWidth="1" />)}
        {safeAxes.map((axis, index) => {
          const [x, y] = point(index, 1)
          return <line key={axis.label} x1={center} y1={center} x2={x} y2={y} stroke="#d1d5db" />
        })}
        <polygon points={safeAxes.map((axis, index) => point(index, axis.value / 100).join(',')).join(' ')} fill="#6366f1" fillOpacity=".25" stroke="#4f46e5" strokeWidth="2.5" />
        {safeAxes.map((axis, index) => {
          const [x, y] = point(index, axis.value / 100)
          const [labelX, labelY] = point(index, 1.25)
          return <g key={axis.label}><circle cx={x} cy={y} r="3.5" fill="#4338ca" /><text x={labelX} y={labelY} textAnchor="middle" dominantBaseline="middle" fontSize="10" fill="#374151">{axis.label}</text></g>
        })}
        <circle cx={center} cy={center} r="28" fill="white" stroke="#c7d2fe" />
        <text x={center} y={center - 5} textAnchor="middle" dominantBaseline="middle" fontSize="13" fontWeight="700" fill="#312e81">{overall}%</text>
        <text x={center} y={center + 12} textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="#4b5563">준비도</text>
      </svg>
    </div>
    <div className="grid gap-2 sm:grid-cols-2">
      {safeAxes.map(axis => <div key={axis.label} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="flex items-center justify-between gap-2 text-sm"><strong>{axis.label}</strong><span className={axis.value < 50 ? 'font-semibold text-amber-700' : 'font-semibold text-indigo-700'}>{axis.value}%</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200"><div className="h-full rounded-full bg-indigo-500" style={{ width: axis.value + '%' }} /></div>
        <p className="mt-2 text-xs leading-5 text-gray-600">{axis.detail}</p>
      </div>)}
    </div>
  </div>
}
