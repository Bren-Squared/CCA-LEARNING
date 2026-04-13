export async function GET() {
  return Response.json({
    status: "ok",
    service: "cca-foundations-app",
    ts: new Date().toISOString(),
  });
}
