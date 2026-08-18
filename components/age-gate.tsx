"use client";

import { useEffect, useState } from "react";

const KEY = "obs.age-confirmed";

/**
 * Ontario's legal drinking age is 19. This is a shell-level gate rather than
 * a page component because it has to wrap everything, including a shared trip
 * link opened cold by someone who has never seen the site.
 *
 * Deliberately not a dark pattern: it states why it's asking, and declining
 * is a real option that leads somewhere sensible rather than a dead end.
 */
export function AgeGate() {
  const [needed, setNeeded] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(KEY) !== "yes") setNeeded(true);
    } catch {
      // Private browsing or storage disabled — ask every time rather than fail open.
      setNeeded(true);
    }
  }, []);

  function confirm() {
    try {
      window.localStorage.setItem(KEY, "yes");
    } catch {
      /* Storage unavailable; the gate simply reappears next visit. */
    }
    setNeeded(false);
  }

  if (!needed) return null;

  return (
    <div
      className="fixed inset-0 grid place-items-center px-5"
      style={{ zIndex: "var(--z-modal)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
    >
      <div
        className="absolute inset-0 survey-grid-bg"
        style={{ zIndex: "var(--z-modal-backdrop)" }}
        aria-hidden="true"
      />
      <div
        className="relative w-full max-w-md border border-line bg-surface-raised p-7"
        style={{ zIndex: "var(--z-modal)", borderRadius: "var(--radius-lg)" }}
      >
        {declined ? (
          <>
            <h2 id="age-gate-title" className="survey-display text-xl mb-3">
              No problem
            </h2>
            <p className="text-sm text-muted leading-relaxed">
              This site is about visiting breweries, so we can only show it to
              people of legal drinking age in Ontario. Thanks for stopping by.
            </p>
          </>
        ) : (
          <>
            <p className="survey-label mb-3">Ontario · 19+</p>
            <h2 id="age-gate-title" className="survey-display text-2xl mb-3">
              Are you 19 or older?
            </h2>
            <p className="text-sm text-muted leading-relaxed mb-6">
              We plan brewery visits, so we have to ask once. We don&rsquo;t
              store your answer anywhere but this device.
            </p>
            <div className="flex gap-2.5">
              <button
                onClick={confirm}
                className="flex-1 bg-primary text-on-primary px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90"
                style={{ borderRadius: "var(--radius)" }}
              >
                Yes, I&rsquo;m 19+
              </button>
              <button
                onClick={() => setDeclined(true)}
                className="px-4 py-2.5 text-sm border border-line text-muted transition-colors hover:text-ink"
                style={{ borderRadius: "var(--radius)" }}
              >
                No
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
