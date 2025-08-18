'use client'

import { useEffect, useState } from 'react'

const THEME_KEY = 'theme'

export default function DarkModeToggle() {
  // mounted controls whether transitions should run (prevents initial jump)
  const [mounted, setMounted] = useState(false)
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'dark') return true
    if (stored === 'light') return false
    // default to light (off) when no stored preference
    return false
  })

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (isDark) root.classList.add('dark')
    else root.classList.remove('dark')
    try { localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light') } catch {}
  }, [isDark])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      const stored = localStorage.getItem(THEME_KEY)
      if (stored == null) setIsDark(e.matches)
    }
    if (mq.addEventListener) mq.addEventListener('change', handler)
    else mq.addListener(handler)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler)
      else mq.removeListener(handler)
    }
  }, [])

  const toggle = () => setIsDark(s => !s)

  return (
    <div className="dark-toggle-wrapper">
      <button
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        role="switch"
        aria-checked={isDark}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
        data-mounted={mounted}
        className={`dark-toggle ${isDark ? 'dark-toggle-on' : ''}`}
      >
        <span className="dark-toggle-knob" />
      </button>
    </div>
  )
}