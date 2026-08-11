import React from 'react'

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'small' | 'medium'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({ variant = 'secondary', size = 'medium', className, type = 'button', ...props }: ButtonProps): React.JSX.Element {
  return <button type={type} className={classes('ui-button', `ui-button-${variant}`, `ui-button-${size}`, className)} {...props} />
}

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: ButtonSize
}

export function IconButton({ label, size = 'medium', className, title, type = 'button', ...props }: IconButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={classes('ui-icon-button', `ui-icon-button-${size}`, className)}
      aria-label={label}
      title={title ?? label}
      {...props}
    />
  )
}

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'local'

export function StatusBadge({ tone = 'neutral', children, className }: { tone?: BadgeTone; children: React.ReactNode; className?: string }): React.JSX.Element {
  return <span className={classes('ui-status-badge', `ui-status-badge-${tone}`, className)}>{children}</span>
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select className={classes('ui-select', className)} {...props} />
}

export function SettingsRow({
  title,
  description,
  children
}: {
  title: string
  description?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ui-settings-row">
      <div className="ui-settings-row-copy">
        <div className="ui-settings-row-title">{title}</div>
        {description ? <div className="ui-settings-row-description">{description}</div> : null}
      </div>
      {children ? <div className="ui-settings-row-control">{children}</div> : null}
    </div>
  )
}
