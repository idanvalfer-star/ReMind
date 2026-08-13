/**
 * Inline SVG icons.
 *
 * Hand-drawn rather than pulled from an icon package: the app needs a handful of glyphs, and a
 * dependency for that would cost more bundle than the whole set. `currentColor` throughout so the active tab
 * and the header states need no icon variants.
 *
 * None of them are directional, so nothing here needs mirroring under RTL.
 */

interface IconProps {
  /** Matches the surrounding text size by default. */
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function CheckCircleIcon({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  );
}

export function CalendarIcon({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </svg>
  );
}

export function SearchIcon({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20.5 20.5" />
    </svg>
  );
}

export function SettingsIcon({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6M17.9 17.9l-1.6-1.6M7.7 7.7L6.1 6.1" />
    </svg>
  );
}

/** Header bell. Filled dot when reminders are on, so the state reads without a label. */
export function BellIcon({ size = 21, active = false }: IconProps & { active?: boolean }) {
  return (
    <svg {...base(size)}>
      <path d="M18 15.5V10.5a6 6 0 10-12 0v5l-1.5 2.5h15L18 15.5z" />
      <path d="M9.8 20.5a2.4 2.4 0 004.4 0" />
      {active && <circle cx="18" cy="6" r="2.6" fill="currentColor" stroke="none" />}
    </svg>
  );
}

export function PeopleIcon({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      {/* Two overlapping figures, the rear one clipped by the front — reads as "people" at 22px
          where a crowd of three does not. */}
      <circle cx="9.5" cy="8.5" r="3.5" />
      <path d="M3.5 19.5c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 5.6a3.5 3.5 0 010 5.8" />
      <path d="M17.5 13.9c1.8.8 3 2.6 3 4.6" />
    </svg>
  );
}

export function TripIcon({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      {/* A suitcase: body, handle, and the two catches. Not a plane — trips here are also trains
          and cars, and a plane would misdescribe most of them. */}
      <rect x="3" y="7.5" width="18" height="12.5" rx="2.5" />
      <path d="M9 7.5V5.5a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 5.5v2" />
      <path d="M8.5 11v6M15.5 11v6" />
    </svg>
  );
}
