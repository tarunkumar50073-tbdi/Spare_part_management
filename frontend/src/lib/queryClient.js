import { QueryClient } from "@tanstack/react-query";

// Shared client-side query cache. Defaults tuned for an internal LAN dashboard:
// treat data as fresh for 30s (so navigating back doesn't refetch immediately),
// keep it 5 min after unused, retry once (not to death on a flaky LAN), and
// don't refetch on window focus (a wallboard/kiosk would otherwise thrash).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
