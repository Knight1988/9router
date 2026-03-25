/**
 * Health check endpoint for container orchestration
 * Returns 200 OK if the server is running and ready to accept requests
 */
export async function GET() {
  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString()
  }, {
    status: 200
  });
}
