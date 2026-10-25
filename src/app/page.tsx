import { ArrowRight, CreditCard, Layers, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { config } from "@/server/config";
import { Shell } from "@/components/pay/shell";
import { Button } from "@/components/ui/button";

const STEPS = [
  { title: "Reserve", body: "Each card is reserved for its share. Nothing is charged yet." },
  { title: "Everyone's in", body: "Once the whole order total is reserved, the cards are charged together." },
  { title: "Or nothing", body: "If time runs out or someone cancels, every reservation is released." },
];

export default async function Home() {
  await connection();
  const c = config();
  return (
    <Shell mode={c.PAYMENT_PROVIDER} wide>
      <div className="flex flex-col gap-10 py-2 sm:py-6">
        <section className="flex max-w-2xl flex-col gap-4">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Split one purchase — across cards or between people.</h1>
          <p className="text-base text-muted-foreground sm:text-lg">
            Zaka Lite adds two ways to pay at a store&apos;s checkout. Everyone sees exactly what they owe, and the order is charged only
            when the full total is covered.
          </p>
          {c.DEMO_STORE_ENABLED ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
              <Button asChild size="lg" className="self-start">
                <Link href="/demo-store">
                  Try it in the demo store <ArrowRight />
                </Link>
              </Button>
              <p className="text-sm text-muted-foreground">A demonstration store with test carts. Use test cards only.</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Payments start from the merchant&apos;s checkout.</p>
          )}
        </section>

        <section aria-labelledby="ways-heading" className="flex flex-col gap-4">
          <h2 id="ways-heading" className="sr-only">
            Two ways to pay
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Feature icon={<Layers className="size-5" aria-hidden />} title="Split across two cards">
              One shopper pays the order with two of their own cards. Enter either amount and the other is calculated for you.
            </Feature>
            <Feature icon={<Users className="size-5" aria-hidden />} title="Split with someone">
              You and one other person each pay a share you agree, with one or two cards each. They get a private link by email.
            </Feature>
          </div>
        </section>

        <section aria-labelledby="how-heading" className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <h2 id="how-heading" className="text-lg font-semibold">
            How payment works
          </h2>
          <ol className="mt-4 grid gap-4 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand" aria-hidden>
                  {i + 1}
                </span>
                <span>
                  <span className="block font-medium">{s.title}</span>
                  <span className="block text-sm text-muted-foreground">{s.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <ul className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            No account needed — each person uses their own private payment link.
          </li>
          <li className="flex items-start gap-2">
            <CreditCard className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            Card details go straight to the card processor; Zaka never stores them.
          </li>
        </ul>
      </div>
    </Shell>
  );
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
      <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand">{icon}</span>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
