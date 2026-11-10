import { Fragment } from "react";

import { cellTone, parseMarkdown, type Block, type Inline } from "@/lib/office-report";
import { TONE_CLASS } from "@/lib/office-labels";
import { cn } from "@/lib/utils";

// A gap report as the client saw it. The Markdown is parsed into plain data
// and rendered as React elements, so nothing in it can become HTML.

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === "text") return <Fragment key={i}>{n.v}</Fragment>;
        if (n.t === "strong") return <strong key={i}><Inlines nodes={n.c} /></strong>;
        if (n.t === "em") return <em key={i}><Inlines nodes={n.c} /></em>;
        if (n.t === "code") return <code key={i} className="rounded bg-muted px-1 text-[0.9em]">{n.v}</code>;
        return (
          <span key={i} className="ml-0.5 rounded bg-muted px-1 text-[11px] text-muted-foreground">
            {n.label}
          </span>
        );
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case "h": {
      const Tag = (`h${block.level + 1}` as "h3" | "h4" | "h5");
      return (
        <Tag className={cn("font-semibold", block.level === 2 ? "mt-5 text-base" : "mt-4 text-sm")}>
          <Inlines nodes={block.c} />
        </Tag>
      );
    }
    case "p":
      return <p className="mt-2 text-sm whitespace-pre-line"><Inlines nodes={block.c} /></p>;
    case "ul":
      return <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{block.items.map((item, i) => <li key={i}><Inlines nodes={item} /></li>)}</ul>;
    case "ol":
      return <ol start={block.start} className="mt-2 list-decimal space-y-1 pl-5 text-sm">{block.items.map((item, i) => <li key={i}><Inlines nodes={item} /></li>)}</ol>;
    case "quote":
      return <blockquote className="mt-2 border-l-2 pl-3 text-sm text-muted-foreground"><Inlines nodes={block.c} /></blockquote>;
    case "hr":
      return <hr className="my-4" />;
    case "table":
      return (
        <div className="mt-3 overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>{block.head.map((cell, i) => <th key={i} className="px-3 py-2 font-medium"><Inlines nodes={cell} /></th>)}</tr>
            </thead>
            <tbody className="divide-y">
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => {
                    const tone = cellTone(cell);
                    return (
                      <td key={c} className="px-3 py-2 align-top">
                        {tone ? (
                          <span className={cn("inline-flex rounded-md border px-1.5 py-0.5 text-xs font-medium", TONE_CLASS[tone])}>
                            <Inlines nodes={cell} />
                          </span>
                        ) : (
                          <Inlines nodes={cell} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function ReportView({ content }: { content: string }) {
  const blocks = parseMarkdown(content);
  return <div className="max-w-none">{blocks.map((block, i) => <BlockView key={i} block={block} />)}</div>;
}
