import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

export const packageName = '@8cards/ui';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'small' | 'medium' | 'large';
  icon?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'medium',
  icon,
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`ui-button ui-button--${variant} ui-button--${size} ${className}`.trim()}
      {...props}
    >
      {icon ? <span className="ui-button__icon">{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
}

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  as?: 'section' | 'article' | 'aside' | 'div';
  tone?: 'glass' | 'solid' | 'felt';
}

export function Panel({
  as: Component = 'section',
  tone = 'glass',
  className = '',
  ...props
}: PanelProps) {
  return (
    <Component
      className={`ui-panel ui-panel--${tone} ${className}`.trim()}
      {...props}
    />
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'gold' | 'green' | 'red' | 'blue' | 'neutral';
  dot?: boolean;
}

export function Badge({
  tone = 'neutral',
  dot = false,
  className = '',
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={`ui-badge ui-badge--${tone} ${className}`.trim()}
      {...props}
    >
      {dot ? <span className="ui-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export interface PlayerSeatProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  avatar: string;
  cards?: number;
  status?: string;
  role?: string;
  active?: boolean;
  online?: boolean;
  compact?: boolean;
}

export function PlayerSeat({
  name,
  avatar,
  cards,
  status,
  role,
  active = false,
  online = true,
  compact = false,
  className = '',
  ...props
}: PlayerSeatProps) {
  return (
    <div
      className={`ui-seat ${active ? 'ui-seat--active' : ''} ${compact ? 'ui-seat--compact' : ''} ${className}`.trim()}
      {...props}
    >
      <div className="ui-seat__avatar" aria-hidden="true">
        {avatar}
        <span
          className={`ui-seat__presence ${online ? '' : 'ui-seat__presence--offline'}`}
        />
      </div>
      <div className="ui-seat__details">
        <div className="ui-seat__name-row">
          <strong>{name}</strong>
          {role ? <span className="ui-seat__role">{role}</span> : null}
        </div>
        <span className="ui-seat__meta">
          {status ?? (cards === undefined ? '等待入座' : `${cards} 张牌`)}
        </span>
      </div>
      {active ? <span className="ui-seat__turn">行动中</span> : null}
    </div>
  );
}

export type CardSuit = 'spade' | 'heart' | 'club' | 'diamond' | 'joker';

export interface PlayingCardProps extends HTMLAttributes<HTMLDivElement> {
  rank: string;
  suit: CardSuit;
  selected?: boolean;
  legal?: boolean;
  disabled?: boolean;
  facedown?: boolean;
  compact?: boolean;
}

const suitSymbols: Record<CardSuit, string> = {
  spade: '♠',
  heart: '♥',
  club: '♣',
  diamond: '♦',
  joker: '★',
};

export function PlayingCard({
  rank,
  suit,
  selected = false,
  legal = false,
  disabled = false,
  facedown = false,
  compact = false,
  className = '',
  ...props
}: PlayingCardProps) {
  const state = [
    selected ? 'ui-card--selected' : '',
    legal ? 'ui-card--legal' : '',
    disabled ? 'ui-card--disabled' : '',
    facedown ? 'ui-card--facedown' : '',
    compact ? 'ui-card--compact' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const accessibleName = facedown ? '牌背' : `${suitSymbols[suit]} ${rank}`;

  return (
    <div
      className={`ui-card ui-card--${suit} ${state} ${className}`.trim()}
      aria-label={accessibleName}
      {...props}
    >
      {facedown ? (
        <span className="ui-card__back-mark">八</span>
      ) : (
        <>
          <span className="ui-card__corner">
            <strong>{rank}</strong>
            <span>{suitSymbols[suit]}</span>
          </span>
          <span className="ui-card__suit" aria-hidden="true">
            {suitSymbols[suit]}
          </span>
          {legal ? <span className="ui-card__legal-mark">可出</span> : null}
        </>
      )}
    </div>
  );
}
