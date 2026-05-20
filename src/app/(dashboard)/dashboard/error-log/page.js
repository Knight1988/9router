import ConsoleLogClient from "../console-log/ConsoleLogClient";

// Force dynamic so Next.js standalone build includes the server-side JS file
export const dynamic = "force-dynamic";

export default function ErrorLogPage() {
  return <ConsoleLogClient endpoint="/api/translator/error-logs" />;
}
