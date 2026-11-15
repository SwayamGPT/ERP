import { can, type Permission } from '@hisaab/core';
import { useUi } from './store';

export function useCan() {
  const session = useUi((s) => s.session);
  return (p: Permission) => can(session?.role, p, session);
}
