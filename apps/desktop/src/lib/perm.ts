import { can, type Permission } from '@hisaab/core';
import { useUi } from './store';

export function useCan() {
  const role = useUi((s) => s.session?.role);
  return (p: Permission) => can(role, p);
}
