import { NextResponse } from "next/server";
import { getSSLStatus, saveUploadedCerts, deleteUploadedCerts } from "@/lib/ssl";

export async function GET() {
  try {
    const status = getSSLStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { cert, key } = await request.json();
    if (!cert || !key) {
      return NextResponse.json(
        { error: "Both cert and key are required" },
        { status: 400 }
      );
    }
    const result = saveUploadedCerts(cert, key);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    const result = deleteUploadedCerts();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
