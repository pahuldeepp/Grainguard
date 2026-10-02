import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { BillingApi } from "./billing-api";
import { EmptyState, ErrorState, Loading, PageHeader } from "./ui";

const plans = [
  { key: "starter", name: "Starter", description: "Core monitoring for a small operation." },
  { key: "growth", name: "Growth", description: "More devices, retention, and team capacity." },
  { key: "scale", name: "Scale", description: "High-volume monitoring and priority support." },
];

export function BillingView({ api, sessionId }: { api: BillingApi | null; sessionId?: string }) {
  const query = useQuery({ queryKey: ["billing", sessionId], queryFn: () => api!.snapshot(), enabled: Boolean(api && sessionId), retry: false });
  const action = useMutation({ mutationFn: ({ kind, plan }: { kind: "checkout" | "portal"; plan?: string }) => kind === "checkout" ? api!.checkout(plan!, window.location.href, window.location.href) : api!.portal(window.location.href) });
  useEffect(() => { if (action.data?.url) window.location.assign(action.data.url); }, [action.data?.url]);
  if (!api || !sessionId) return <section className="read-view"><PageHeader id="billing-title" title="Billing" /><EmptyState title="Sign in to view billing." /></section>;
  if (query.isPending) return <section className="read-view"><PageHeader id="billing-title" title="Billing" /><Loading label="Loading billing…" rows={3} /></section>;
  if (query.isError) return <section className="read-view"><PageHeader id="billing-title" title="Billing" /><ErrorState message="Billing is temporarily unavailable." onRetry={() => void query.refetch()} /></section>;
  const subscription = query.data.subscription;
  const subscribed = subscription.planKey !== "free" && subscription.status !== "canceled";
  return <section className="read-view" aria-labelledby="billing-title">
    <PageHeader id="billing-title" title="Billing">Tenant plan and Stripe billing</PageHeader>
    <section className="section"><h2>Current plan</h2><p className="num data">{subscription.planKey}</p><p>Status: <strong>{subscription.status}</strong>{subscription.currentPeriodEnd && ` · renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}</p>{subscribed && <button className="btn btn-secondary" type="button" disabled={action.isPending} onClick={() => action.mutate({ kind: "portal" })}>Manage billing in Stripe</button>}</section>
    {!subscribed && <section className="section"><h2>Choose a plan</h2><div className="metric-grid">{plans.map((plan) => <article className="status-card" key={plan.key}><h3>{plan.name}</h3><p className="meta">{plan.description}</p><button className="btn btn-primary" type="button" disabled={action.isPending} onClick={() => action.mutate({ kind: "checkout", plan: plan.key })}>Buy with Stripe</button></article>)}</div></section>}
    {query.data.usage.length > 0 && <section className="section"><h2>Usage</h2><ul className="rows">{query.data.usage.map((item) => <li className="service-row" key={`${item.meter}-${item.periodStart}`}><span>{item.meter}</span><strong>{item.total}</strong></li>)}</ul></section>}
    {action.isError && <p role="alert" className="field-error">{action.error instanceof Error ? action.error.message : "Billing action failed."}</p>}
    <p className="meta">Payments are hosted by Stripe. GreenGuard never handles card details.</p>
  </section>;
}
