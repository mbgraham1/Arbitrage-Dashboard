import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import { useToast } from "@/hooks/use-toast";
import { Siren, RefreshCw } from "lucide-react";
import {
  useGetTriIndeterminate,
  getGetTriIndeterminateQueryKey,
  useResolveTriIndeterminate,
} from "@workspace/api-client-react";

/**
 * Persistent dashboard alert for a triangular order in an INDETERMINATE
 * cancel state: the post-timeout cancel was never confirmed terminal by
 * Kraken, so the order may still be resting and could fill later. The trader
 * must reconcile it manually (or re-check it here) before trading again —
 * the server blocks new live triangular executions while it is pending.
 */
export function TriReconcileBanner() {
  const { credentials } = useBotContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data } = useGetTriIndeterminate({
    query: {
      queryKey: getGetTriIndeterminateQueryKey(),
      refetchInterval: 10_000,
      refetchOnWindowFocus: true,
    },
  });

  const resolveMutation = useResolveTriIndeterminate();

  const pending = data?.pending;
  if (!pending) return null;

  const hasKrakenCreds = !!credentials.krakenKey && !!credentials.krakenSecret;

  const recheck = () => {
    resolveMutation.mutate(
      { data: { krakenKey: credentials.krakenKey, krakenSecret: credentials.krakenSecret } },
      {
        onSuccess: (res) => {
          toast({
            title: res.cleared ? "Order resolved — gate cleared" : "Still indeterminate",
            description: res.message ?? (res.cleared ? "Kraken confirmed a terminal status. Live triangular trading is unblocked." : undefined),
            variant: res.cleared ? "default" : "destructive",
          });
          void queryClient.invalidateQueries({ queryKey: getGetTriIndeterminateQueryKey() });
        },
        onError: (e) =>
          toast({ title: "Re-check failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
      },
    );
  };

  return (
    <div
      className="border-4 border-destructive bg-destructive/10 p-4 flex flex-col gap-2"
      data-testid="banner-tri-indeterminate"
    >
      <div className="flex items-center gap-2 text-destructive font-bold uppercase text-sm">
        <Siren className="h-5 w-5 animate-pulse" />
        Triangular order needs manual reconciliation — live tri trading blocked
      </div>
      <p className="text-sm font-mono">
        Order <span className="font-bold" data-testid="text-tri-indeterminate-txid">{pending.txid}</span>
        {pending.pair ? <> on <span className="font-bold">{pending.pair}</span></> : null}
        {pending.legLabel ? <> ({pending.legLabel})</> : null}
        {pending.loop ? <> from loop {pending.loop}</> : null}
        {" "}went indeterminate at {pending.sinceMs ? new Date(pending.sinceMs).toLocaleString() : "unknown time"}.
        The cancel was never confirmed terminal — it may still be resting on Kraken and could fill later.
        Verify it on Kraken (and rebalance any late fill) before trading.
      </p>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="destructive"
          onClick={recheck}
          disabled={!hasKrakenCreds || resolveMutation.isPending}
          data-testid="button-tri-indeterminate-recheck"
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${resolveMutation.isPending ? "animate-spin" : ""}`} />
          {resolveMutation.isPending ? "Re-checking…" : "Re-check on Kraken"}
        </Button>
        {!hasKrakenCreds && (
          <span className="text-xs font-mono text-muted-foreground">
            Enter Kraken API keys to re-check from here.
          </span>
        )}
      </div>
    </div>
  );
}
