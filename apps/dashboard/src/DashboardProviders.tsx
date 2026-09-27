import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as ReduxProvider } from "react-redux";
import type { PropsWithChildren } from "react";
import { dashboardStore } from "./dashboard-state";

export const dashboardQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

export function DashboardProviders({ children }: Readonly<PropsWithChildren>) {
  return (
    <ReduxProvider store={dashboardStore}>
      <QueryClientProvider client={dashboardQueryClient}>
        {children}
      </QueryClientProvider>
    </ReduxProvider>
  );
}
