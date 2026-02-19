type SoundName = 'select' | 'move' | 'capture' | 'check' | 'win' | 'toggle'

let audioCtx: AudioContext | null = null

const getAudioCtx = async () => {
  if (!audioCtx) {
    const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    audioCtx = new Ctx()
  }

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume()
  }

  return audioCtx
}

const tone = async (frequency: number, duration: number, gain = 0.06, type: OscillatorType = 'sine', delay = 0) => {
  const ctx = await getAudioCtx()
  if (!ctx) return

  const osc = ctx.createOscillator()
  const gainNode = ctx.createGain()

  osc.type = type
  osc.frequency.value = frequency
  gainNode.gain.value = 0

  osc.connect(gainNode)
  gainNode.connect(ctx.destination)

  const startTime = ctx.currentTime + delay
  const endTime = startTime + duration

  gainNode.gain.setValueAtTime(0, startTime)
  gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.01)
  gainNode.gain.exponentialRampToValueAtTime(0.0001, endTime)

  osc.start(startTime)
  osc.stop(endTime + 0.02)
}

export const playSound = async (name: SoundName) => {
  switch (name) {
    case 'select':
      await tone(620, 0.06, 0.04, 'triangle')
      break
    case 'move':
      await tone(520, 0.09, 0.05, 'triangle')
      break
    case 'capture':
      await tone(420, 0.07, 0.06, 'square')
      await tone(290, 0.12, 0.05, 'square', 0.06)
      break
    case 'check':
      await tone(760, 0.08, 0.05, 'sawtooth')
      await tone(960, 0.12, 0.05, 'sawtooth', 0.07)
      break
    case 'win':
      await tone(520, 0.1, 0.06, 'triangle')
      await tone(780, 0.1, 0.06, 'triangle', 0.1)
      await tone(1040, 0.16, 0.06, 'triangle', 0.2)
      break
    case 'toggle':
      await tone(680, 0.07, 0.04, 'sine')
      break
    default:
      break
  }
}
