type BrowserAudioContext = AudioContext;

export class SynthAudio {
  private context: BrowserAudioContext | null = null;
  private muted = false;

  isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  playTone(frequency = 660, durationSeconds = 0.08): void {
    if (this.muted || typeof window === "undefined" || typeof window.AudioContext === "undefined") return;
    try {
      this.context ??= new window.AudioContext();
      if (this.context.state === "suspended") void this.context.resume().catch(() => undefined);
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = "square";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.035, this.context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + durationSeconds);
      oscillator.connect(gain);
      gain.connect(this.context.destination);
      oscillator.start();
      oscillator.stop(this.context.currentTime + durationSeconds);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    } catch {
      // Audio is optional; blocked or unsupported playback must not stop gameplay.
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}

export const gameAudio = new SynthAudio();
