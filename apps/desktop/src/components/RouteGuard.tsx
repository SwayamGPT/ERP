import type { Permission } from '@hisaab/core';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCan } from '../lib/perm';

/**
 * Screens a role may not use: the menu already hides them, and this stops a typed or bookmarked
 * address from opening an empty or half-working screen. (Data is protected in the database layer
 * regardless; this is about a clear screen.)
 */
export function RequirePerm({ perm, children }: { perm: Permission; children: ReactNode }) {
  const can = useCan();
  if (can(perm)) return <>{children}</>;
  return (
    <div className="card mx-auto mt-10 max-w-md p-6 text-center" data-testid="no-access">
      <Lock className="mx-auto mb-2 h-7 w-7 text-muted" />
      <h2 className="text-lg font-semibold">Not available for your login</h2>
      <p className="mt-1 text-sm text-muted">Ask the owner if you need this screen.</p>
      <Link to="/" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">Go to Home</Link>
    </div>
  );
}
