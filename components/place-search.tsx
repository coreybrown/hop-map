'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Brewery } from '@/lib/types';
import { coordKey, type AnchorPoint } from '@/lib/trip-url';
import type { Place } from '@/components/map-app';

/**
 * Type where you're going — a town, or a brewery by name.
 *
 * The dropdown of 15 preset cities couldn't answer "is there anything near
 * Bellwoods" or find a brewery whose town isn't on the list, and 246 records
 * in a <select> is not a search. Everything is already loaded on the client,
 * so this needs no geocoding service: it matches against the registry we hold.
 *
 * Towns rank above breweries because they're what people usually mean by
 * "where I'm going"; a brewery match sets the anchor to that brewery's own
 * coordinates, which is how "near this place" gets expressed.
 */

export interface SearchChoice {
  /** Trip value: a place key, or an `@lat,lng` string. */
  value: string;
  label: string;
  kind: 'place' | 'brewery';
  /** Present for breweries, so the caller can select it on the map too. */
  breweryId?: string;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function PlaceSearch({
  label,
  current,
  places,
  breweries,
  onChoose,
  placeholder,
}: {
  label: string;
  current: AnchorPoint | null;
  places: Place[];
  breweries: Brewery[];
  onChoose: (choice: SearchChoice) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);

  const results = useMemo<SearchChoice[]>(() => {
    const q = norm(query);
    if (!q) {
      return places.slice(0, 8).map((p) => ({ value: p.key, label: p.label, kind: 'place' }));
    }

    const placeHits: SearchChoice[] = places
      .filter((p) => norm(p.label).includes(q))
      .map((p) => ({ value: p.key, label: p.label, kind: 'place' as const }));

    const breweryHits: SearchChoice[] = breweries
      .filter((b) => norm(b.name).includes(q) || (b.city && norm(b.city).includes(q)))
      // A name that STARTS with the query is what you meant; one that merely
      // contains it usually isn't.
      .sort((a, b) => {
        const as = norm(a.name).startsWith(q) ? 0 : 1;
        const bs = norm(b.name).startsWith(q) ? 0 : 1;
        return as - bs || a.name.localeCompare(b.name);
      })
      .slice(0, 8)
      .map((b) => ({
        value: coordKey(b.lat!, b.lng!),
        label: b.name,
        kind: 'brewery' as const,
        breweryId: b.id,
      }));

    return [...placeHits, ...breweryHits].slice(0, 12);
  }, [query, places, breweries]);

  useEffect(() => setActive(0), [query]);

  // Click-away closes, which is what every combobox does and what people expect.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  function commit(choice: SearchChoice) {
    onChoose(choice);
    setQuery('');
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[active]) commit(results[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div ref={wrap} className="relative flex items-center gap-2">
      <span className="survey-label w-10 shrink-0">{label}</span>
      <div className="relative min-w-0 flex-1">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={`${label} — search a town or brewery`}
          value={open ? query : (current?.label ?? '')}
          placeholder={current ? current.label : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="h-10 w-full rounded-survey border border-line bg-surface px-2.5 text-sm text-ink transition-colors duration-150 placeholder:text-muted hover:border-line-strong"
        />

        {open && results.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            /* Fixed-position would escape the panel's overflow; the panel
               doesn't clip here, and absolute keeps it anchored on scroll. */
            className="absolute left-0 right-0 top-11 z-[var(--z-dropdown,30)] max-h-64 overflow-y-auto rounded-survey border border-line bg-surface-raised py-1 shadow-xl"
          >
            {results.map((r, i) => (
              <li key={`${r.kind}-${r.value}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(r)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors duration-100 ${
                    i === active ? 'bg-primary-soft text-ink' : 'text-muted hover:text-ink'
                  }`}
                >
                  <span className="truncate">{r.label}</span>
                  <span className="survey-label shrink-0">
                    {r.kind === 'brewery' ? 'brewery' : 'town'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {open && query && results.length === 0 && (
          <p className="absolute left-0 right-0 top-11 z-[var(--z-dropdown,30)] rounded-survey border border-line bg-surface-raised px-3 py-2 text-sm text-muted shadow-xl">
            No town or brewery matches “{query}”.
          </p>
        )}
      </div>
    </div>
  );
}
