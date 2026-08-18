'use client';

import { useState } from 'react';

/**
 * Saving and sharing are the same action.
 *
 * There is no account and no backend, so the link IS the saved plan — texting
 * it to yourself is how it survives until Saturday, and texting it to the three
 * friends coming along costs nothing extra. That is a deliberate architectural
 * choice from core-loop.md, not a missing feature.
 *
 * Uses the native share sheet on phones (where the plan actually gets sent) and
 * falls back to clipboard on desktop (where it gets made).
 */
export function ShareTrip({ label }: { label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function share() {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: `Breweries — ${label}`, url });
        return;
      } catch {
        // User dismissed the sheet, or the browser refused. Fall through to
        // clipboard rather than leaving them with nothing.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
      setTimeout(() => setState('idle'), 2200);
    } catch {
      setState('failed');
      setTimeout(() => setState('idle'), 4000);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={share}
        className="h-9 rounded-survey border border-line bg-surface-raised px-3 text-sm font-medium text-ink transition-colors duration-150 hover:border-line-strong"
      >
        Save this plan
      </button>
      <span
        role="status"
        aria-live="polite"
        className={`text-sm transition-opacity duration-150 ${
          state === 'idle' ? 'opacity-0' : 'opacity-100'
        } ${state === 'failed' ? 'text-warn' : 'text-fresh'}`}
      >
        {state === 'copied' && 'Link copied — text it to yourself'}
        {state === 'failed' && 'Copy failed — use your browser’s share menu'}
      </span>
    </div>
  );
}
