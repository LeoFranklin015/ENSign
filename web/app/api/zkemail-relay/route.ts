import { NextResponse } from "next/server";

/**
 * Server-side proxy for a zkEmail relayer.
 *
 * Two reasons this exists rather than calling the relayer from the browser:
 *
 *  - CORS. The relayer allows only `authorization, accept, content-type`, so
 *    adding `ngrok-skip-browser-warning` (needed to stop ngrok's free tier
 *    serving an HTML interstitial) makes the preflight fail. Server-to-server
 *    requests aren't subject to CORS, so we can send both freely.
 *  - It keeps the relayer's address out of the browser bundle when it's set
 *    server-side.
 *
 * POST { action: "submit", body }   -> { id }
 * POST { action: "status", id }     -> { status, proof? }
 */

const RELAYER =
  process.env.ZKEMAIL_RELAYER ?? process.env.NEXT_PUBLIC_ZKEMAIL_RELAYER ?? "";

const HEADERS = {
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "true",
};

export async function POST(req: Request) {
  try {
    if (!RELAYER) {
      return NextResponse.json(
        { error: "no relayer configured (set ZKEMAIL_RELAYER)" },
        { status: 500 },
      );
    }
    const { action, body, id } = (await req.json()) as {
      action?: string;
      body?: Record<string, unknown>;
      id?: string;
    };

    if (action === "submit") {
      const res = await fetch(`${RELAYER}/submit`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(body ?? {}),
      });
      const text = await res.text();
      if (!res.ok) {
        return NextResponse.json(
          { error: `relayer ${res.status}: ${text.slice(0, 300)}` },
          { status: 502 },
        );
      }
      const json = JSON.parse(text) as { id?: string };
      if (!json.id) {
        return NextResponse.json(
          { error: `relayer returned no request id: ${text.slice(0, 200)}` },
          { status: 502 },
        );
      }
      return NextResponse.json({ id: json.id });
    }

    if (action === "status") {
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const res = await fetch(`${RELAYER}/status/${id}`, { headers: HEADERS });
      const text = await res.text();
      if (!res.ok) {
        return NextResponse.json(
          { error: `relayer ${res.status}: ${text.slice(0, 300)}` },
          { status: 502 },
        );
      }
      const json = JSON.parse(text) as {
        request?: { status?: string };
        response?: { proof?: unknown } | null;
      };
      return NextResponse.json({
        status: json.request?.status ?? "Unknown",
        proof: json.response?.proof,
      });
    }

    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return NextResponse.json(
      { error: String(err?.shortMessage ?? err?.message ?? err) },
      { status: 400 },
    );
  }
}
