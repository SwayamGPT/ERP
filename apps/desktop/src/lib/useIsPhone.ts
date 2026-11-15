import { useEffect, useState } from 'react';

const QUERY = '(max-width: 760px)';

/** True on phone-sized screens, where the pocket layout replaces the counter UI. */
export function useIsPhone() {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const m = window.matchMedia(QUERY);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}
