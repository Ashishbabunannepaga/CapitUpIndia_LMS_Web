import Link from "next/link";
import { Mail, MessageCircle, Phone, Sparkles, SquareArrowOutUpRight } from "lucide-react";

import type { NextAction } from "@/lib/next-actions";

const ICONS = { WhatsApp: MessageCircle, Call: Phone, Email: Mail, Open: SquareArrowOutUpRight } as const;

/** "Do this next": the top few actions for the viewer, each with one-click links. */
export function NextActions({ items }: { items: NextAction[] }) {
  if (!items.length) return null;
  return (
    <section className="surface mb-6 p-4 sm:p-5" aria-labelledby="next-actions">
      <h2 id="next-actions" className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4 text-amber-500" /> Do this next
      </h2>
      <ol className="space-y-2">
        {items.map((item, i) => (
          <li key={item.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                <Link href={item.href} className="hover:underline">
                  {item.title}
                </Link>
              </p>
              <p className="text-xs text-muted-foreground">{item.why}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {item.links.map((link) => {
                const Icon = ICONS[link.label];
                const external = !link.href.startsWith("/");
                return external ? (
                  <a
                    key={link.label}
                    href={link.href}
                    target={link.href.startsWith("http") ? "_blank" : undefined}
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                  >
                    <Icon className="size-3.5" /> {link.label}
                  </a>
                ) : (
                  <Link key={link.label} href={link.href} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
                    <Icon className="size-3.5" /> {link.label}
                  </Link>
                );
              })}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
