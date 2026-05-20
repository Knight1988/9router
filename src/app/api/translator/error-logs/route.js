import { NextResponse } from "next/server";
import { clearErrorLogs, getErrorLogs, initConsoleLogCapture } from "@/lib/consoleLogBuffer";

initConsoleLogCapture();

export async function GET() {
  try {
    const logs = getErrorLogs();
    return NextResponse.json({ success: true, logs });
  } catch (error) {
    console.error("Error getting error logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    clearErrorLogs();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error clearing error logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
