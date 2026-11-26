import { getSession } from "@/lib/auth";
import { taskVoice } from "@/server/data/work-tasks";

// A task thread's voice note (?m=<message id>), for someone who can see the
// task. Supports byte ranges, which Safari needs before it plays audio.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const taskId = Number((await params).id);
  const messageId = Number(new URL(request.url).searchParams.get("m"));
  if (!session || !Number.isInteger(taskId) || taskId <= 0 || !Number.isInteger(messageId) || messageId <= 0) {
    return new Response("Not found", { status: 404 });
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
  const range = match ? { offset: Number(match[1]), ...(match[2] ? { length: Number(match[2]) - Number(match[1]) + 1 } : {}) } : null;
  if (range && (range.length !== undefined && range.length <= 0)) return new Response("Bad range", { status: 416 });

  const voice = await taskVoice(session.ctx, session.actor, taskId, messageId, range);
  if (!voice) return new Response("Not found", { status: 404 });
  if (voice.range && voice.range.offset >= voice.size) {
    return new Response("Bad range", { status: 416, headers: { "Content-Range": `bytes */${voice.size}` } });
  }
  const headers: Record<string, string> = {
    "Content-Type": voice.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  if (voice.range) {
    headers["Content-Range"] = `bytes ${voice.range.offset}-${voice.range.offset + voice.range.length - 1}/${voice.size}`;
    headers["Content-Length"] = String(voice.range.length);
    return new Response(voice.body, { status: 206, headers });
  }
  headers["Content-Length"] = String(voice.size);
  return new Response(voice.body, { headers });
}
