import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('renderer error boundary caught:', error, info)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="empty">
          <h2>Something went wrong</h2>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--red)' }}>
            {String(this.state.error.message ?? this.state.error)}
          </p>
          <button className="btn-ghost" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
