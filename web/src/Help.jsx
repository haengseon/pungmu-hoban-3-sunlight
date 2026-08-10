import React, { useEffect, useRef } from 'react'

// 조작법 안내. 3D 를 돌려보는 앱인데 나침반 말고는 그렇게 생겼다는 표시가 없어서,
// 처음 온 사람은 지도가 평면인 줄 알고 나간다. 한 번만 보여주고 기억한다.
const SEEN = 'hoban3.help.seen'

export const helpSeen = () => {
  try {
    return localStorage.getItem(SEEN) === '1'
  } catch {
    return false // 사파리 프라이빗 모드 등. 못 기억하면 매번 보여준다
  }
}

const markSeen = () => {
  try {
    localStorage.setItem(SEEN, '1')
  } catch { /* 기억 못 해도 앱은 돌아간다 */ }
}

const stroke = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
  strokeLinecap: 'round', strokeLinejoin: 'round',
}

const Glyph = ({ children }) => (
  <svg viewBox="0 0 32 32" aria-hidden="true"><g {...stroke}>{children}</g></svg>
)

// 손가락은 채운 점, 마우스는 몸체 + 눌린 버튼, 움직임은 촉이 달린 화살표.
// 아이콘 하나에 개념 하나만 담는다.
const Dot = ({ cx, cy }) => <circle cx={cx} cy={cy} r="3" fill="currentColor" stroke="none" />
// 몸체 + 버튼 경계선. 어느 버튼을 쓰는지는 그 칸을 채워서 말한다.
const Mouse = () => (
  <>
    <path d="M16 3a7 7 0 0 1 7 7v6a7 7 0 0 1-14 0v-6a7 7 0 0 1 7-7z" />
    <path d="M9 11h14M16 3v8" />
  </>
)
const SIDEWAYS = <path d="M7 27h18M10 24l-3 3 3 3M22 24l3 3-3 3" />

// 손가락 하나가 축을 돈다
const ROTATE = (
  <Glyph>
    <path d="M25.5 12.5A10.5 10.5 0 1 0 27 19" />
    <path d="M20.5 12.5h5.5V7" />
    <Dot cx="16" cy="16" />
  </Glyph>
)
// 손가락 둘이 함께 미끄러진다
const PAN = (
  <Glyph>
    <Dot cx="10" cy="20" />
    <Dot cx="17" cy="20" />
    <path d="M11 12.5l10-6.5" />
    <path d="M15.5 5.2l5.8.5-.6 5.8" />
  </Glyph>
)
// 손가락 둘이 대각선으로 벌어진다
const PINCH = (
  <Glyph>
    <Dot cx="11" cy="21" />
    <Dot cx="21" cy="11" />
    <path d="M7.5 24.5l-4 4M3.5 24.2v4.3h4.3" />
    <path d="M24.5 7.5l4-4M28.5 7.8V3.5h-4.3" />
  </Glyph>
)
// 손가락이 건물 하나를 짚는다
const TAP = (
  <Glyph>
    <path d="M6 27V13h6V6h8v7h6v14z" />
    <Dot cx="16" cy="20" />
  </Glyph>
)
const DRAG = (
  <Glyph>
    <path d="M9 11a7 7 0 0 1 7-8v8z" fill="currentColor" stroke="none" />
    <Mouse />
    {SIDEWAYS}
  </Glyph>
)
const RIGHT_DRAG = (
  <Glyph>
    <path d="M23 11a7 7 0 0 0-7-8v8z" fill="currentColor" stroke="none" />
    <Mouse />
    {SIDEWAYS}
  </Glyph>
)
const WHEEL = (
  <Glyph>
    <Mouse />
    <path d="M16 5.5v3.5" strokeWidth="2.6" />
    <path d="M28 13.5V7M25.8 9.2L28 7l2.2 2.2" />
    <path d="M28 18.5V25M25.8 22.8L28 25l2.2-2.2" />
  </Glyph>
)

// 필지가 갈린 계획도 한 장. 이 지구는 아직 대부분 나대지라 '옆에 뭐가 들어서나' 가
// 그림자만큼 궁금한 정보인데, 켜져 있는 줄 모르면 그냥 지도 무늬로 읽힌다.
const PLAN = (
  <Glyph>
    <path d="M4 5h24v22H4z" />
    <path d="M4 15h11M15 5v22M15 21h13" />
  </Glyph>
)
const PLAN_ROW = [PLAN, '토지이용계획', '빈 부지에 들어설 용도 (끌 수 있음)']

const TOUCH = [
  [ROTATE, '한 손가락 끌기', '돌리기 · 기울이기'],
  [PAN, '두 손가락 끌기', '위치 옮기기'],
  [PINCH, '두 손가락 벌리기', '확대 · 축소'],
  [TAP, '건물 탭', '그 동 선택'],
  PLAN_ROW,
]
const MOUSE = [
  [DRAG, '드래그', '위치 옮기기'],
  [RIGHT_DRAG, '오른쪽 버튼 드래그', '돌리기 · 기울이기'],
  [WHEEL, '휠', '확대 · 축소'],
  [TAP, '건물 클릭', '그 동 선택'],
  PLAN_ROW,
]

/**
 * @param {{open: boolean, onClose: () => void}} props
 */
export default function Help({ open, onClose }) {
  const cardRef = useRef(null)

  const dismiss = () => {
    markSeen()
    onClose()
  }

  useEffect(() => {
    if (!open) return undefined
    // 카드 자체에 포커스를 준다. 버튼에 주면 크롬이 마우스로 온 사람에게도
    // 포커스 링을 그려서, 열자마자 검은 테두리가 튀어나온다.
    cardRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!open) return null
  const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const rows = touch ? TOUCH : MOUSE

  return (
    <div className="help" onClick={dismiss}>
      <div
        className="help-card"
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="help-title">건물을 돌려가며 봅니다</h2>
        <p className="help-sub">
          계절과 시각을 바꾸면 그림자가 따라 움직입니다.
        </p>
        <ul>
          {rows.map(([icon, how, what]) => (
            <li key={how}>
              {icon}
              <b>{how}</b>
              <span>{what}</span>
            </li>
          ))}
        </ul>
        <p className="help-warn">
          <b>참고용 시뮬레이션</b>입니다. 층고·이격거리 등 추정값으로 계산해 실제
          일조량과 차이가 있을 수 있습니다.
        </p>
        <button className="help-go" onClick={dismiss}>
          시작하기
        </button>
      </div>
    </div>
  )
}
