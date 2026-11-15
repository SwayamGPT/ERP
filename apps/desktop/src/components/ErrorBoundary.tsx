import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * If one screen crashes, show a calm message for that screen instead of a blank app. The rest of
 * the app (menu, billing tabs, data) keeps working; moving to another screen resets it.
 */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('Screen crashed:', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card mx-auto mt-10 max-w-lg p-6 text-center" data-testid="screen-error">
        <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-warn" />
        <h2 className="text-lg font-semibold">This screen hit a problem</h2>
        <p className="mt-1 text-sm text-muted">Your data is safe. Try again, or open another screen from the menu.</p>
        <p className="mt-3 break-words font-mono text-[11px] text-faint">{this.state.error.message}</p>
        <button className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg" onClick={() => this.setState({ error: null })}>
          <RotateCcw className="h-4 w-4" /> Try again
        </button>
      </div>
    );
  }
}

export function ScreenBoundary({ children }: { children: ReactNode }) {
  const loc = useLocation();
  return <Boundary key={loc.pathname}>{children}</Boundary>;
}
