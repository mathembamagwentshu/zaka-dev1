import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";
import { config } from "@/server/config";
import { Button } from "@/components/ui/button";

export default async function Home() {
  await connection();
  const demo = config().DEMO_STORE_ENABLED;
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-4 py-16">
      <Image src="/zaka-logo.png" alt="Zaka" width={56} height={56} priority />
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Zaka Lite sandbox</h1>
        <p className="mt-2 text-muted-foreground">
          Split one purchase across two cards, or between two people. Payments start at the merchant&apos;s checkout; there is no
          way to create a payment from here.
        </p>
      </div>
      <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm">Test mode only — no real cards and no real money.</p>
      {demo ? (
        <Button asChild size="lg" className="self-start">
          <Link href="/demo-store">
            Open the demo test store <ArrowRight />
          </Link>
        </Button>
      ) : null}
    </main>
  );
}
