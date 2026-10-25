import { CheckCircle2, CircleDashed, CreditCard, Loader2, RotateCcw, XCircle } from "lucide-react";
import type { CurrencyCode } from "@/lib/currency";
import { formatMoney } from "@/lib/money";
import type { CardStatus, CardView } from "@/lib/view-types";
import { Badge } from "@/components/ui/badge";

const LABEL: Record<CardStatus, { text: string; tone: "neutral" | "brand" | "success" | "warning" | "danger" | "info" }> = {
  pending: { text: "Waiting", tone: "neutral" },
  awaiting_card: { text: "Enter card", tone: "brand" },
  action_required: { text: "Verifying", tone: "info" },
  reserved: { text: "Reserved", tone: "info" },
  paid: { text: "Charged", tone: "success" },
  declined: { text: "Declined", tone: "danger" },
  released: { text: "Released", tone: "neutral" },
  releasing: { text: "Releasing", tone: "neutral" },
  capture_failed: { text: "Not charged", tone: "danger" },
  refunded: { text: "Refunded", tone: "warning" },
};

function Icon({ status }: { status: CardStatus }) {
  if (status === "paid") return <CheckCircle2 className="size-5 text-success" aria-hidden />;
  if (status === "reserved") return <CheckCircle2 className="size-5 text-info" aria-hidden />;
  if (status === "declined" || status === "capture_failed") return <XCircle className="size-5 text-danger" aria-hidden />;
  if (status === "released" || status === "refunded") return <RotateCcw className="size-5 text-muted-foreground" aria-hidden />;
  if (status === "action_required" || status === "releasing") return <Loader2 className="size-5 animate-spin text-info" aria-hidden />;
  if (status === "awaiting_card") return <CreditCard className="size-5 text-brand" aria-hidden />;
  return <CircleDashed className="size-5 text-muted-foreground" aria-hidden />;
}

export function CardList({
  cards,
  currency,
  title = "Your cards",
  activePosition,
}: {
  cards: CardView[];
  currency: CurrencyCode;
  title?: string;
  /** Card currently being entered: shown as "Enter card" even before the server has its intent. */
  activePosition?: number;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {cards.map((raw) => {
          const c = raw.position === activePosition && raw.status === "pending" ? { ...raw, status: "awaiting_card" as const } : raw;
          return (
          <li key={c.position} className="flex items-center gap-3 px-4 py-3">
            <Icon status={c.status} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Card {c.position}</p>
              {c.last4 ? (
                <p className="text-xs text-muted-foreground">
                  {c.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : "Card"} •••• {c.last4}
                </p>
              ) : null}
              {c.message ? <p className="text-xs text-danger">{c.message}</p> : null}
            </div>
            <span className="tabular text-sm font-semibold">{formatMoney(c.amountMinor, currency)}</span>
            <Badge tone={LABEL[c.status].tone}>{LABEL[c.status].text}</Badge>
          </li>
          );
        })}
      </ul>
    </div>
  );
}
