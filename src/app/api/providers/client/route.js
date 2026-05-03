import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { backfillCodexEmails } from "@/lib/oauth/providers";

// GET /api/providers/client - List all connections for client (includes sensitive fields for sync)
export async function GET() {
  try {
    await backfillCodexEmails();
    const connections = await getProviderConnections();
    
    // Include sensitive fields for sync to cloud (only accessible from same origin),
    // but strip monitorCreds.password to avoid leaking it to the UI.
    const clientConnections = connections.map(c => {
      if (c.providerSpecificData?.monitorCreds) {
        return {
          ...c,
          providerSpecificData: {
            ...c.providerSpecificData,
            monitorCreds: { username: c.providerSpecificData.monitorCreds.username || "" },
          },
        };
      }
      return c;
    });

    return NextResponse.json({ connections: clientConnections });
  } catch (error) {
    console.log("Error fetching providers for client:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}
