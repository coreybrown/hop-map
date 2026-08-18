'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { PLACES } from '@/lib/data';
import { STYLE_LABELS, STYLE_TAGS, type StyleTag } from '@/lib/types';
import { tripToSearch, type Trip } from '@/lib/trip-url';

/**
 * The whole input half of the core loop: where you're going, and what you like.
 *
 * Submitting navigates rather than setting local state, because the URL is the
 * plan. That also means back/forward step through previous searches for free,
 * and a half-built query can be sent to someone mid-thought.
 *
 * Structured inputs, not natural language — decided in HANDOFF: a form does
 * this job with no API key, no latency and no hallucination risk.
 */
export function TripForm({ initial }: { initial: Trip }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [mode, setMode] = useState<'place' | 'route'>(initial.from ? 'route' : 'place');
  const [from, setFrom] = useState(initial.from ?? '');
  const [to, setTo] = useState(initial.to ?? '');
  const [styles, setStyles] = useState<StyleTag[]>(initial.styles);
  const [shop, setShop] = useState(Boolean(initial.requireBottleShop));
  const [food, setFood] = useState(Boolean(initial.requireFood));

  const toggle = (tag: StyleTag) =>
    setStyles((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trip: Trip = {
      from: mode === 'route' ? from || undefined : undefined,
      to: to || undefined,
      styles,
      requireBottleShop: shop,
      requireFood: food,
    };
    startTransition(() => router.push(`/${tripToSearch(trip)}`, { scroll: false }));
  }

  const places = Object.entries(PLACES);

  return (
    <form onSubmit={submit} className="grid gap-7">
      {/* Point or corridor — the two shapes of the same question. */}
      <fieldset className="grid gap-3">
        <legend className="survey-label mb-2">Where are you going</legend>

        <div
          role="radiogroup"
          aria-label="Search shape"
          className="inline-flex w-fit rounded-survey border border-line bg-surface p-0.5"
        >
          {(['place', 'route'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-[2px] px-3 py-1.5 text-sm font-medium transition-colors duration-150 ${
                mode === m
                  ? 'bg-primary text-on-primary'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {m === 'place' ? 'A place' : 'A route'}
            </button>
          ))}
        </div>

        <div className={`grid gap-3 ${mode === 'route' ? 'sm:grid-cols-2' : ''}`}>
          {mode === 'route' && (
            <label className="grid gap-1.5">
              <span className="survey-label">Starting from</span>
              <select
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-11 rounded-survey border border-line bg-surface-raised px-3 text-ink transition-colors duration-150 hover:border-line-strong"
              >
                <option value="">Choose a starting point…</option>
                {places.map(([key, p]) => (
                  <option key={key} value={key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="grid gap-1.5">
            <span className="survey-label">
              {mode === 'route' ? 'Driving to' : 'In or near'}
            </span>
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              className="h-11 rounded-survey border border-line bg-surface-raised px-3 text-ink transition-colors duration-150 hover:border-line-strong"
            >
              <option value="">Choose a destination…</option>
              {places.map(([key, p]) => (
                <option key={key} value={key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset className="grid gap-2.5">
        <legend className="survey-label mb-2">
          What do you like{' '}
          <span className="font-normal normal-case tracking-normal text-muted">
            — pick any, or none to see everything
          </span>
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {STYLE_TAGS.map((tag) => {
            const on = styles.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(tag)}
                className={`rounded-survey border px-2.5 py-1.5 text-sm transition-colors duration-150 ${
                  on
                    ? 'border-primary bg-primary-soft font-medium text-primary'
                    : 'border-line bg-surface-raised text-muted hover:border-line-strong hover:text-ink'
                }`}
              >
                {STYLE_LABELS[tag]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Check label="Has a bottle shop" checked={shop} onChange={setShop} />
        <Check label="Serves food" checked={food} onChange={setFood} />

        <button
          type="submit"
          disabled={!to || pending}
          className="ml-auto h-11 rounded-survey bg-accent px-5 font-medium text-on-accent transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'Working…' : 'Find breweries'}
        </button>
      </div>
    </form>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-[32px] cursor-pointer items-center gap-2 text-sm text-muted transition-colors duration-150 hover:text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-[18px] accent-[var(--primary)]"
      />
      {label}
    </label>
  );
}
