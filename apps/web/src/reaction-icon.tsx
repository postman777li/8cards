import type { ReactionId } from './experience.js';

export function ReactionIcon({ id }: { id: ReactionId }) {
  return (
    <svg
      className="reaction-svg"
      data-reaction={id}
      viewBox="0 0 64 64"
      aria-hidden="true"
      width="40"
      height="40"
      fill="none"
      stroke="#382710"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="32" cy="32" r="28" fill="#ffd77d" stroke="#ffeac0" />
      {id === 'like' ? (
        <path
          d="M20 32h8l7-17q7 0 4 13h10l-4 20H28V32M17 32v16h7V32z"
          fill="#fff0c7"
        />
      ) : null}
      {id === 'clap' ? (
        <>
          <path
            d="M13 38l9-18 5 3-5 15 13-17 5 4-12 20zM30 43l13-23 5 3-8 18 10-8 4 5-16 14z"
            fill="#fff0c7"
          />
          <path d="M17 10l-3-5M34 10V4M50 13l5-5" />
        </>
      ) : null}
      {id === 'laugh' ? (
        <>
          <path
            d="M15 25q6-9 12 0M37 25q6-9 12 0M16 34h32q-2 22-16 20Q18 54 16 34"
            fill="#692d2c"
          />
          <path d="M22 46q10-8 20 0" stroke="#ff9e9d" strokeWidth="6" />
        </>
      ) : null}
      {id === 'think' ? (
        <>
          <path d="M15 23l12-3M39 21l9 3M18 43q11-9 20-2" />
          <circle cx="23" cy="28" r="2" fill="#382710" />
          <circle cx="43" cy="28" r="2" fill="#382710" />
          <path d="M37 52V40q-1-7 4-7l4 10 7-3 4 7-8 8z" fill="#fff0c7" />
        </>
      ) : null}
      {id === 'wow' ? (
        <>
          <circle cx="21" cy="25" r="5" fill="#fff" />
          <circle cx="43" cy="25" r="5" fill="#fff" />
          <ellipse cx="32" cy="43" rx="7" ry="10" fill="#692d2c" />
        </>
      ) : null}
      {id === 'cheer' ? (
        <>
          <path d="M18 28l7-6 7 6M36 28l7-6 7 6M23 38q9 12 18 0M5 17L1 9M57 17l6-8" />
          <path d="M10 45l7-7 7 9-9 10zM43 47l7-9 7 7-5 12z" fill="#fff0c7" />
        </>
      ) : null}
      {id === 'facepalm' ? (
        <>
          <path d="M16 28l11 2M39 28l10-2M24 46q8-4 14 0" />
          <path
            d="M29 41L19 21q-2-7 3-7l7 13-4-17q0-5 4-3l7 18-1-17q2-5 5-1l5 21 3-12q5-4 6 2l-5 24-7 9z"
            fill="#fff0c7"
          />
        </>
      ) : null}
    </svg>
  );
}
