import { useMutation, useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { call } from '../db/client';
import type { ArgsOf, Method, ResultOf } from '../db/api';
import { toast } from '../components/ui';

export function useApi<M extends Method>(
  method: M,
  args?: ArgsOf<M>,
  opts?: Omit<UseQueryOptions<Awaited<ResultOf<M>>, Error>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<Awaited<ResultOf<M>>, Error>({
    queryKey: [method, args ?? null],
    queryFn: () => (call as (m: M, a?: unknown) => Promise<Awaited<ResultOf<M>>>)(method, args),
    ...opts,
  });
}

export function useAction<M extends Method>(method: M, opts: { success?: string | ((r: Awaited<ResultOf<M>>) => string); onSuccess?: (r: Awaited<ResultOf<M>>) => void; silentError?: boolean } = {}) {
  return useMutation<Awaited<ResultOf<M>>, Error, ArgsOf<M>>({
    mutationFn: (a) => (call as (m: M, a?: unknown) => Promise<Awaited<ResultOf<M>>>)(method, a),
    onSuccess: (r) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r);
    },
    onError: (e) => !opts.silentError && toast.error(e),
  });
}
