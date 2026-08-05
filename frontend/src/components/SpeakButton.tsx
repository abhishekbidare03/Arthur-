import { useEffect, useState } from 'react'
import { speak, speechAvailable, stopSpeaking, whenVoicesReady } from '../voice/speech'
import { SpeakerIcon, SpeakerOffIcon } from './icons'

interface SpeakButtonProps {
  /** Raw markdown. Stripped to prose before speaking — see `voice/speech.ts`. */
  content: string
}

/**
 * Reads one answer aloud.
 *
 * Renders nothing at all when no *offline* voice exists, rather than showing a
 * button that would either fail or quietly make a network call. Arthur's whole
 * premise is that nothing leaves the machine.
 */
export default function SpeakButton({ content }: SpeakButtonProps) {
  const [available, setAvailable] = useState(speechAvailable)
  const [speaking, setSpeaking] = useState(false)

  // Chrome populates the voice list asynchronously and returns [] on the first
  // call, so "unavailable" is not a verdict until the list has actually loaded.
  useEffect(() => {
    if (available) return
    let cancelled = false
    void whenVoicesReady().then((voices) => {
      if (!cancelled) setAvailable(voices.length > 0)
    })
    return () => {
      cancelled = true
    }
  }, [available])

  // Speech outlives the component — navigating away mid-sentence would
  // otherwise leave a disembodied voice reading a message no longer on screen.
  useEffect(() => {
    return () => {
      if (speaking) stopSpeaking()
    }
  }, [speaking])

  if (!available) return null

  function toggle() {
    if (speaking) {
      stopSpeaking()
      setSpeaking(false)
      return
    }
    setSpeaking(true)
    speak(content, () => setSpeaking(false))
  }

  return (
    <button
      className="btn-icon h-7 w-7"
      onClick={toggle}
      title={speaking ? 'Stop reading' : 'Read aloud'}
      aria-label={speaking ? 'Stop reading' : 'Read aloud'}
      aria-pressed={speaking}
      style={speaking ? { color: 'var(--accent)' } : undefined}
    >
      {speaking ? <SpeakerOffIcon className="h-[15px] w-[15px]" /> : <SpeakerIcon className="h-[15px] w-[15px]" />}
    </button>
  )
}
