import { ArrowLeft, Compass } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Shell } from "@/components/pay/shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <Shell>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Compass className="size-7 text-muted-foreground" aria-hidden />
            <h1 className="text-xl font-semibold tracking-tight">We couldn&apos;t find that page</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            The address may be mistyped, or the page no longer exists. If you were paying, open the payment link from your email or
            the store again, exactly as it was sent.
          </p>
          <Button asChild variant="secondary" className="self-start">
            <Link href="/">
              <ArrowLeft /> Go to the start page
            </Link>
          </Button>
        </CardContent>
      </Card>
    </Shell>
  );
}
